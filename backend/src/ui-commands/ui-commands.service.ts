/**
 * UiCommandService — the server side of the "agent controls the UI" channel.
 *
 * An agent (an MCP client authed AS the user) ENQUEUES a command; the user's open
 * cockpit DRAINS pending commands on a focus-gated poll and applies them. Both
 * paths run inside `withWorkspace(workspaceId, ucUid, …)` (the RLS chokepoint) and
 * scope by an explicit (workspaceId, ucUid) predicate — the per-WORKSPACE RLS
 * fence plus the per-USER ucUid fence in app code, so a command only ever reaches
 * the user it was addressed to. Delivery is DELETE-on-read: drain deletes the
 * caller's rows and returns them in ONE atomic statement, so a row is handed to
 * exactly one drainer (two racing tabs never double-apply) and consumed/stale rows
 * never accumulate. Commands older than `STALE_MS` are deleted but NOT applied (a
 * long-offline tab won't get a burst of ancient navigations), and the applied set
 * is capped at `MAX_DRAIN` so a flood can't jam the cockpit.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, UiCommandKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UiCommandView, kindToWire } from './ui-commands.types';

/** Commands older than this are deleted but never applied (effectively expire). */
const STALE_MS = 5 * 60 * 1000;
/** Cap on how many commands one drain applies (a flood can't jam the cockpit). */
const MAX_DRAIN = 50;

/** One row as returned by the raw DELETE … RETURNING. */
interface UiCommandRow {
  id: string;
  kind: UiCommandKind;
  payload: unknown;
  createdAt: Date;
}

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

  /**
   * Atomically DELETE the caller's commands and return them. The single
   * DELETE … RETURNING is the claim: a row is removed exactly once, so concurrent
   * drains can't double-apply (and stale rows are swept, not left to accumulate).
   * Only the fresh ones (created within `STALE_MS`) are applied, oldest first,
   * bounded to `MAX_DRAIN`.
   */
  async drain(workspaceId: string, ucUid: string): Promise<UiCommandView[]> {
    if (!ucUid || !ucUid.trim()) return [];
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const cutoffMs = Date.now() - STALE_MS;
      const rows = await tx.$queryRaw<UiCommandRow[]>(Prisma.sql`
        DELETE FROM "ui_commands"
        WHERE "workspaceId" = ${workspaceId} AND "ucUid" = ${ucUid}
        RETURNING "id", "kind", "payload", "createdAt"
      `);
      return rows
        .filter((r) => r.createdAt.getTime() > cutoffMs)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, MAX_DRAIN)
        .map((r) => this.toView(r));
    });
  }

  private toView(row: UiCommandRow): UiCommandView {
    // JSONB comes back parsed from $queryRaw, but coerce defensively.
    const payload =
      typeof row.payload === 'string'
        ? (JSON.parse(row.payload) as Record<string, unknown>)
        : ((row.payload ?? {}) as Record<string, unknown>);
    return {
      id: row.id,
      kind: kindToWire(row.kind),
      payload,
      created_at: row.createdAt.toISOString(),
    };
  }
}
