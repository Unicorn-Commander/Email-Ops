/**
 * DispositionService — the thread folder overlay (Inbox / Archive / Trash / Spam).
 *
 * A thread's folder placement is stored as a thin OVERLAY (one row per moved
 * thread); absence of a row means INBOX. The overlay is merged over the federated
 * mailbox at read time — never a fork of the engine's mailbox state. Every method
 * runs inside withWorkspace (RLS-fenced) AND carries an explicit workspaceId
 * predicate (defense-in-depth: RLS is inert under the owner role today, so the
 * predicate is the real fence — the lesson from the command-center hardening pass).
 */

import { Injectable } from '@nestjs/common';
import { MessageDisposition, ThreadDisposition } from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { DispositionView } from './mail-triage.types';

@Injectable()
export class DispositionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The effective disposition for a set of thread ids, as a Map (default INBOX
   * for any thread with no overlay row). tx-based: callers merge this into a
   * thread list from INSIDE their own withWorkspace (one tx, no nesting).
   */
  async getDispositionMap(
    tx: WorkspaceTxClient,
    workspaceId: string,
    threadIds: string[],
  ): Promise<Map<string, MessageDisposition>> {
    const map = new Map<string, MessageDisposition>();
    if (threadIds.length === 0) return map;
    const rows = await tx.threadDisposition.findMany({
      where: { workspaceId, threadId: { in: threadIds } },
    });
    for (const r of rows) map.set(r.threadId, r.disposition);
    return map;
  }

  /** Thread ids carrying a specific disposition (for server-side folder filtering). */
  async threadIdsWithDisposition(
    tx: WorkspaceTxClient,
    workspaceId: string,
    dispositions: MessageDisposition[],
  ): Promise<string[]> {
    const rows = await tx.threadDisposition.findMany({
      where: { workspaceId, disposition: { in: dispositions } },
      select: { threadId: true },
    });
    return rows.map((r) => r.threadId);
  }

  /** Move a thread to a folder (upsert the overlay row). */
  async setDisposition(
    workspaceId: string,
    ucUid: string | null,
    threadId: string,
    disposition: MessageDisposition,
    opts?: { agentKey?: string | null },
  ): Promise<DispositionView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const row = await tx.threadDisposition.upsert({
        where: { workspaceId_threadId: { workspaceId, threadId } },
        create: {
          workspaceId,
          threadId,
          disposition,
          setByUcUid: ucUid,
          setByAgentKey: opts?.agentKey ?? null,
        },
        update: {
          disposition,
          setByUcUid: ucUid,
          setByAgentKey: opts?.agentKey ?? null,
        },
      });
      return this.toView(row);
    });
  }

  /** List the overlay rows (optionally one folder), newest first. */
  async list(
    workspaceId: string,
    ucUid: string | null,
    disposition?: MessageDisposition,
  ): Promise<DispositionView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const rows = await tx.threadDisposition.findMany({
        where: { workspaceId, ...(disposition ? { disposition } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: 500,
      });
      return rows.map((r) => this.toView(r));
    });
  }

  private toView(r: ThreadDisposition): DispositionView {
    return {
      thread_id: r.threadId,
      disposition: r.disposition,
      set_by_uc_uid: r.setByUcUid,
      set_by_agent_key: r.setByAgentKey,
      updated_at: r.updatedAt.toISOString(),
    };
  }
}
