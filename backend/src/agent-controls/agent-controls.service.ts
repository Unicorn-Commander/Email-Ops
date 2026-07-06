/**
 * AgentControlsService — the workspace kill switch + the activity/audit feed.
 *
 * The kill switch is `Workspace.agentsPaused` (read by EmailService.composeEmail
 * to refuse agent compose while paused). Toggling it records a PAUSED/RESUMED row
 * in the agent-mail action log, which is also the source of the activity feed.
 * Workspace-scoped via withWorkspace (RLS scopes the event reads/writes).
 */

import { Injectable, Logger } from '@nestjs/common';
import { AgentActionKind, AgentInboxState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentActivityView, AgentControlsView, AgentMetricsView } from './agent-controls.types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Metrics window bounds (days). Default a week; clamp so a hostile query can't scan forever. */
const DEFAULT_WINDOW_DAYS = 7;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

/** Agent-action kinds that represent a real SEND (autonomous or approved-then-sent). */
const SENT_KINDS: AgentActionKind[] = [
  AgentActionKind.AUTONOMOUS_SEND,
  AgentActionKind.APPROVED,
];

/**
 * Parse the `?window=` query (e.g. "7d", "30d", or a bare number of days) into a
 * clamped day count. Anything unparseable falls back to the default.
 */
export function parseWindowDays(raw?: string): number {
  if (!raw) return DEFAULT_WINDOW_DAYS;
  const m = /^(\d+)\s*d?$/i.exec(raw.trim());
  const n = m ? Number.parseInt(m[1], 10) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.max(Math.trunc(n), MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
}

@Injectable()
export class AgentControlsService {
  private readonly logger = new Logger(AgentControlsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Read the kill switch. */
  async getControls(workspaceId: string, ucUid: string | null): Promise<AgentControlsView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const ws = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { agentsPaused: true },
      });
      return { agents_paused: ws?.agentsPaused ?? false };
    });
  }

  /** Set the kill switch; records a PAUSED/RESUMED event when the value changes. */
  async setControls(
    workspaceId: string,
    ucUid: string | null,
    agentsPaused: boolean,
  ): Promise<AgentControlsView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const before = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { agentsPaused: true },
      });
      const wasPaused = before?.agentsPaused ?? false;
      if (wasPaused !== agentsPaused) {
        await tx.workspace.update({ where: { id: workspaceId }, data: { agentsPaused } });
        await tx.agentActionEvent.create({
          data: {
            workspaceId,
            kind: agentsPaused ? AgentActionKind.PAUSED : AgentActionKind.RESUMED,
            actorUcUid: ucUid,
            detail: agentsPaused ? 'All agents paused' : 'Agents resumed',
          },
        });
      }
      return { agents_paused: agentsPaused };
    });
  }

  /** Recent agent-mail activity (the audit feed), newest-first. */
  async listActivity(
    workspaceId: string,
    ucUid: string | null,
    limit = DEFAULT_LIMIT,
  ): Promise<AgentActivityView[]> {
    const take = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const rows = await tx.agentActionEvent.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take,
      });
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        agent_key: r.agentKey,
        message_id: r.messageId,
        actor_uc_uid: r.actorUcUid,
        detail: r.detail,
        created_at: r.createdAt?.toISOString() ?? null,
      }));
    });
  }

  /**
   * Real, server-side rail metrics — the honest replacement for the client-side
   * "Triaged" proxy that used to guess from activity-feed volume. Each field is a
   * genuine count over the RLS-fenced, workspace-scoped tables:
   *
   *   triaged  — distinct threads an AGENT filed (ThreadDisposition.setByAgentKey
   *              non-null) whose disposition was set/updated within the window.
   *              (workspaceId + threadId is unique, so the count is distinct
   *              threads. Human-only triage — setByAgentKey null — is excluded.)
   *   sent     — AgentActionEvent rows of AUTONOMOUS_SEND (L2 self-send) or
   *              APPROVED (a staged draft a human approved → sent) in the window.
   *   awaiting — CURRENT pending agent-inbox items (not windowed): the same value
   *              the nav badge reads. "How many drafts still need a human?"
   *
   * Every predicate carries an explicit `workspaceId` (defense-in-depth: RLS is
   * inert under the owner role today, so the predicate is the real tenant fence —
   * the command-center hardening lesson). Degrade-clean: any failure logs and
   * returns zeros; this endpoint NEVER 500s (empty/zero on no data or on error).
   */
  async getMetrics(
    workspaceId: string,
    ucUid: string | null,
    windowDays: number = DEFAULT_WINDOW_DAYS,
  ): Promise<AgentMetricsView> {
    const window = Math.min(
      Math.max(Math.trunc(windowDays) || DEFAULT_WINDOW_DAYS, MIN_WINDOW_DAYS),
      MAX_WINDOW_DAYS,
    );
    const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000);
    try {
      return await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
        const [triaged, sent, awaiting] = await Promise.all([
          tx.threadDisposition.count({
            where: {
              workspaceId,
              setByAgentKey: { not: null },
              updatedAt: { gte: since },
            },
          }),
          tx.agentActionEvent.count({
            where: {
              workspaceId,
              kind: { in: SENT_KINDS },
              createdAt: { gte: since },
            },
          }),
          tx.agentInboxItem.count({
            where: { workspaceId, state: AgentInboxState.PENDING },
          }),
        ]);
        return { triaged, sent, awaiting, window_days: window };
      });
    } catch (err) {
      // Never surface a 500 for a metrics widget — degrade to zeros, log for ops.
      this.logger.warn(
        `agent-metrics failed for workspace=${workspaceId}: ${(err as Error).message}`,
      );
      return { triaged: 0, sent: 0, awaiting: 0, window_days: window };
    }
  }
}
