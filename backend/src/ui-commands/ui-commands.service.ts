/**
 * UiCommandService — the server side of the "agent controls the UI" channel.
 *
 * An agent (an MCP client authed AS the user) ENQUEUES a command; the user's open
 * cockpit DRAINS pending commands on a focus-gated poll and applies them. Both
 * paths run inside `withWorkspace(workspaceId, ucUid, …)` (the RLS chokepoint) and
 * scope by an explicit (workspaceId, ucUid) predicate — the per-WORKSPACE RLS
 * fence plus the per-USER ucUid fence in app code, so a command only ever reaches
 * the user it was addressed to. Delivery is drain-on-read (at-most-once); commands
 * older than `STALE_MS` are never replayed (a long-offline tab won't get a burst of
 * ancient navigations), and rows are ephemeral.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, UiCommand, UiCommandKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UiCommandView, kindToWire } from './ui-commands.types';

/** Commands older than this are skipped on drain (and effectively expire). */
const STALE_MS = 5 * 60 * 1000;

@Injectable()
export class UiCommandService {
  constructor(private readonly prisma: PrismaService) {}

  /** Enqueue a UI command addressed to (workspaceId, ucUid). */
  async enqueue(
    workspaceId: string,
    ucUid: string,
    kind: UiCommandKind,
    payload: Record<string, unknown>,
  ): Promise<{ id: string }> {
    if (!ucUid || !ucUid.trim()) {
      throw new BadRequestException('A target user (ucUid) is required to address a UI command.');
    }
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const row = await tx.uiCommand.create({
        data: { workspaceId, ucUid, kind, payload: payload as Prisma.InputJsonValue },
      });
      return { id: row.id };
    });
  }

  /** Drain the caller's pending, non-stale commands (oldest first) and mark them
   * consumed in the same transaction (at-most-once delivery). */
  async drain(workspaceId: string, ucUid: string): Promise<UiCommandView[]> {
    if (!ucUid || !ucUid.trim()) return [];
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const cutoff = new Date(Date.now() - STALE_MS);
      const pending = await tx.uiCommand.findMany({
        where: { workspaceId, ucUid, consumedAt: null, createdAt: { gt: cutoff } },
        orderBy: { createdAt: 'asc' },
      });
      if (pending.length > 0) {
        await tx.uiCommand.updateMany({
          where: { id: { in: pending.map((p) => p.id) } },
          data: { consumedAt: new Date() },
        });
      }
      return pending.map((p) => this.toView(p));
    });
  }

  private toView(row: UiCommand): UiCommandView {
    return {
      id: row.id,
      kind: kindToWire(row.kind),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      created_at: row.createdAt.toISOString(),
    };
  }
}
