/**
 * SpacesService — the soft grouping layer (Spaces of mailboxes + agents).
 *
 * A Space is a "view" INSIDE the existing RLS workspace (NOT a new tenant): it
 * groups mailboxes + agents by context so the active Space filters /mail + the
 * agents view. Every method runs inside `withWorkspace(workspaceId, ucUid, …)`
 * (the RLS chokepoint) and scopes reads by an explicit workspaceId predicate
 * (correct even under the pre-flip owner role, where RLS is inert).
 *
 * Two fences, layered:
 *   - per-WORKSPACE: the `workspaceId` predicate (+ RLS once the role flips).
 *   - per-USER (PERSONAL spaces): the `ownerKey` predicate — a PERSONAL space is
 *     visible/editable only to its owner. `ownerKey` is canonically the owner's
 *     keycloakId, but a caller's ucUid can arrive as the local User.id depending
 *     on the auth path, so the owner match resolves the caller by EITHER identity
 *     and accepts a match on either (mirrors EmailService.mayActThroughMailbox /
 *     EngineMailProvider.credentialsForUser). TEAM spaces are workspace resources
 *     (any member sees + edits them, v1).
 */

import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, Space, SpaceVisibility } from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { CreateSpaceInput, SpaceView, UpdateSpaceInput } from './spaces.types';

/** The caller's identity set: every id that can legitimately own their spaces,
 * plus the canonical keycloakId to stamp on a new PERSONAL space. */
interface ResolvedCaller {
  /** ucUid + the linked User's keycloakId + the local User.id (deduped). */
  ownerIds: string[];
  /** The keycloakId to stamp as ownerKey (falls back to ucUid when unlinked). */
  canonicalKey: string | null;
}

@Injectable()
export class SpacesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The Spaces this caller can see: their own PERSONAL spaces (ownerKey matches
   * the caller, resolved keycloakId-OR-id) + ALL the workspace's TEAM spaces.
   * Sorted by sortOrder then name.
   */
  async listSpaces(workspaceId: string, ucUid: string | null): Promise<SpaceView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const { ownerIds } = await this.resolveCaller(tx, ucUid);
      const spaces = await tx.space.findMany({
        where: {
          workspaceId,
          OR: [
            { visibility: SpaceVisibility.TEAM },
            { visibility: SpaceVisibility.PERSONAL, ownerKey: { in: ownerIds } },
          ],
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return this.toViews(tx, spaces);
    });
  }

  /** Create a Space. PERSONAL stamps ownerKey = the caller's keycloakId; TEAM is
   * shared (ownerKey null). Membership (mailboxes/agents) is set via the PUT
   * endpoints after create. */
  async createSpace(
    workspaceId: string,
    ucUid: string | null,
    input: CreateSpaceInput,
  ): Promise<SpaceView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const visibility = input.visibility ?? SpaceVisibility.PERSONAL;
      const { canonicalKey } = await this.resolveCaller(tx, ucUid);

      const data: Prisma.SpaceUncheckedCreateInput = {
        workspaceId,
        name: input.name,
        visibility,
        ownerKey: visibility === SpaceVisibility.PERSONAL ? canonicalKey : null,
        color: input.color ?? null,
        icon: input.icon ?? null,
      };
      const created = await tx.space.create({ data });
      return this.toViewOne(tx, created);
    });
  }

  /** Patch a Space (name/color/icon/sortOrder/visibility). Null → 404 at the
   * controller. A PERSONAL space is editable only by its owner; TEAM by any
   * member. Flipping visibility re-stamps the owner. */
  async updateSpace(
    workspaceId: string,
    ucUid: string | null,
    id: string,
    patch: UpdateSpaceInput,
  ): Promise<SpaceView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const existing = await tx.space.findFirst({ where: { id, workspaceId } });
      if (!existing) return null;
      const caller = await this.resolveCaller(tx, ucUid);
      this.assertCanModify(existing, caller);

      const data: Prisma.SpaceUncheckedUpdateInput = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.color !== undefined) data.color = patch.color;
      if (patch.icon !== undefined) data.icon = patch.icon;
      if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
      if (patch.visibility !== undefined && patch.visibility !== existing.visibility) {
        // Keep the invariant: TEAM has no owner; PERSONAL is claimed by the caller.
        data.visibility = patch.visibility;
        data.ownerKey = patch.visibility === SpaceVisibility.TEAM ? null : caller.canonicalKey;
      }
      if (Object.keys(data).length > 0) {
        await tx.space.update({ where: { id: existing.id }, data });
      }
      const fresh = await tx.space.findFirstOrThrow({ where: { id: existing.id } });
      return this.toViewOne(tx, fresh);
    });
  }

  /** Delete a Space (cascade clears its membership rows). False → 404. Owner-only
   * for PERSONAL; any member for TEAM. */
  async deleteSpace(workspaceId: string, ucUid: string | null, id: string): Promise<boolean> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const existing = await tx.space.findFirst({ where: { id, workspaceId } });
      if (!existing) return false;
      this.assertCanModify(existing, await this.resolveCaller(tx, ucUid));
      await tx.space.delete({ where: { id: existing.id } });
      return true;
    });
  }

  /** REPLACE the Space's mailbox set. Rejects any id not in the workspace. */
  async setMailboxes(
    workspaceId: string,
    ucUid: string | null,
    id: string,
    mailboxIds: string[],
  ): Promise<SpaceView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const space = await tx.space.findFirst({ where: { id, workspaceId } });
      if (!space) return null;
      this.assertCanModify(space, await this.resolveCaller(tx, ucUid));

      const ids = [...new Set(mailboxIds)];
      await this.assertMailboxesInWorkspace(tx, workspaceId, ids);
      await tx.spaceMailbox.deleteMany({ where: { spaceId: id } });
      if (ids.length) {
        await tx.spaceMailbox.createMany({
          data: ids.map((mailboxAccountId) => ({ spaceId: id, mailboxAccountId })),
        });
      }
      const fresh = await tx.space.findFirstOrThrow({ where: { id } });
      return this.toViewOne(tx, fresh);
    });
  }

  /** REPLACE the Space's agent set. Rejects any id not in the workspace. */
  async setAgents(
    workspaceId: string,
    ucUid: string | null,
    id: string,
    agentIds: string[],
  ): Promise<SpaceView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const space = await tx.space.findFirst({ where: { id, workspaceId } });
      if (!space) return null;
      this.assertCanModify(space, await this.resolveCaller(tx, ucUid));

      const ids = [...new Set(agentIds)];
      await this.assertAgentsInWorkspace(tx, workspaceId, ids);
      await tx.spaceAgent.deleteMany({ where: { spaceId: id } });
      if (ids.length) {
        await tx.spaceAgent.createMany({
          data: ids.map((agentId) => ({ spaceId: id, agentId })),
        });
      }
      const fresh = await tx.space.findFirstOrThrow({ where: { id } });
      return this.toViewOne(tx, fresh);
    });
  }

  // ── ownership / identity ──────────────────────────────────────────────────

  /**
   * Resolve the caller's identity set. ownerKey is canonically the keycloakId,
   * but ucUid can arrive as the local User.id (auth-path dependent) — resolve the
   * caller by EITHER identity so a legitimate owner is never falsely fenced out.
   * The users table is global (not RLS-fenced), so this read is safe inside the tx.
   */
  private async resolveCaller(tx: WorkspaceTxClient, ucUid: string | null): Promise<ResolvedCaller> {
    const ids = new Set<string>();
    let canonicalKey: string | null = null;
    if (ucUid && ucUid.trim()) {
      ids.add(ucUid);
      canonicalKey = ucUid;
      const u = await tx.user.findFirst({ where: { OR: [{ keycloakId: ucUid }, { id: ucUid }] } });
      if (u) {
        if (u.keycloakId) {
          ids.add(u.keycloakId);
          canonicalKey = u.keycloakId; // prefer the keycloakId as the stamp
        }
        if (u.id) ids.add(u.id);
      }
    }
    return { ownerIds: [...ids], canonicalKey };
  }

  /** True iff this PERSONAL space is owned by the caller. */
  private isOwner(space: Pick<Space, 'ownerKey'>, caller: ResolvedCaller): boolean {
    return !!space.ownerKey && caller.ownerIds.includes(space.ownerKey);
  }

  /** Owner-only for PERSONAL; any member for TEAM (the v1 edit/delete rule). */
  private assertCanModify(
    space: Pick<Space, 'visibility' | 'ownerKey'>,
    caller: ResolvedCaller,
  ): void {
    if (space.visibility === SpaceVisibility.PERSONAL && !this.isOwner(space, caller)) {
      throw new ForbiddenException('Only the owner can modify this personal space.');
    }
  }

  // ── membership validation ───────────────────────────────────────────────

  /** A clear 400 (beats a silent dangling membership) when a mailbox isn't ours. */
  private async assertMailboxesInWorkspace(
    tx: WorkspaceTxClient,
    workspaceId: string,
    ids: string[],
  ): Promise<void> {
    if (!ids.length) return;
    const found = await tx.mailboxAccount.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException(
        'One or more mailbox_ids do not reference a mailbox in this workspace.',
      );
    }
  }

  /** A clear 400 when an agent isn't in this workspace. */
  private async assertAgentsInWorkspace(
    tx: WorkspaceTxClient,
    workspaceId: string,
    ids: string[],
  ): Promise<void> {
    if (!ids.length) return;
    const found = await tx.agent.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException(
        'One or more agent_ids do not reference an agent in this workspace.',
      );
    }
  }

  // ── view mapping ──────────────────────────────────────────────────────────

  private async toViews(tx: WorkspaceTxClient, spaces: Space[]): Promise<SpaceView[]> {
    if (spaces.length === 0) return [];
    const ids = spaces.map((s) => s.id);
    const [mbLinks, agLinks] = await Promise.all([
      tx.spaceMailbox.findMany({ where: { spaceId: { in: ids } } }),
      tx.spaceAgent.findMany({ where: { spaceId: { in: ids } } }),
    ]);
    const mbBy = this.groupBy(mbLinks, (l) => l.spaceId, (l) => l.mailboxAccountId);
    const agBy = this.groupBy(agLinks, (l) => l.spaceId, (l) => l.agentId);
    return spaces.map((s) => this.toView(s, mbBy.get(s.id) ?? [], agBy.get(s.id) ?? []));
  }

  private async toViewOne(tx: WorkspaceTxClient, space: Space): Promise<SpaceView> {
    const [mbLinks, agLinks] = await Promise.all([
      tx.spaceMailbox.findMany({ where: { spaceId: space.id } }),
      tx.spaceAgent.findMany({ where: { spaceId: space.id } }),
    ]);
    return this.toView(
      space,
      mbLinks.map((l) => l.mailboxAccountId),
      agLinks.map((l) => l.agentId),
    );
  }

  private toView(space: Space, mailboxIds: string[], agentIds: string[]): SpaceView {
    return {
      id: space.id,
      name: space.name,
      visibility: space.visibility === SpaceVisibility.TEAM ? 'team' : 'personal',
      color: space.color,
      icon: space.icon,
      sort_order: space.sortOrder,
      mailbox_ids: mailboxIds,
      agent_ids: agentIds,
    };
  }

  private groupBy<T>(rows: T[], key: (r: T) => string, val: (r: T) => string): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const r of rows) {
      const k = key(r);
      const list = m.get(k);
      if (list) list.push(val(r));
      else m.set(k, [val(r)]);
    }
    return m;
  }
}
