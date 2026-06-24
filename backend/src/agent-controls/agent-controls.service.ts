/**
 * AgentControlsService — the workspace kill switch + the activity/audit feed.
 *
 * The kill switch is `Workspace.agentsPaused` (read by EmailService.composeEmail
 * to refuse agent compose while paused). Toggling it records a PAUSED/RESUMED row
 * in the agent-mail action log, which is also the source of the activity feed.
 * Workspace-scoped via withWorkspace (RLS scopes the event reads/writes).
 */

import { Injectable } from '@nestjs/common';
import { AgentActionKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentActivityView, AgentControlsView } from './agent-controls.types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Injectable()
export class AgentControlsService {
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
}
