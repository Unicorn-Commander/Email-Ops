/**
 * WorkspacesService — the multi-org tenancy layer (create-org, members + RBAC,
 * invitations) on top of the existing Workspace + Membership foundation.
 *
 * An org == a Workspace == a hard tenant. This service owns the surface that was
 * missing: minting a new org (the caller becomes its OWNER), listing + managing
 * its members, and the invite → accept flow.
 *
 * Why NOT `withWorkspace` here: `workspaces`, `memberships`, and `invitations`
 * are CONTROL/IDENTITY tables, deliberately NOT RLS-fenced (create-org has no
 * prior workspace context; accept-by-token + list-mine span workspaces). So
 * these are plain Prisma writes, exactly as AuthService/MembershipService write
 * the global tables.
 *
 * The fence is enforced HERE, in app code, by resolving the caller's ACTUAL
 * membership role per request (`resolveCallerRole`) — NOT the membership guard's
 * role (which is permissive OWNER-for-everyone while EMAIL_OPS_TENANCY_ENABLED is
 * off). That makes per-org permissions real regardless of the global flag: you
 * can only manage an org you are actually an ADMIN+ of, and you can never grant a
 * role above your own or strand an org with zero owners.
 */

import { randomBytes, randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Invitation,
  InvitationStatus,
  MembershipStatus,
  Prisma,
  User,
  WorkspaceRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from '../common/workspace/membership.service';
import { MyWorkspace } from '../common/workspace/list-my-workspaces';
import { roleAtLeast, roleRank } from '../common/workspace/role-rank';
import {
  CreateOrgInput,
  InviteInput,
  InviteView,
  MemberView,
  MyInviteView,
  UpdateMemberInput,
  inviteStatusToWire,
  roleToWire,
  statusToWire,
} from './workspaces.types';

/** Invitations live for two weeks unless re-issued. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
  ) {}

  // ── create / rename org ─────────────────────────────────────────────────

  /**
   * Create a new org. The caller becomes its OWNER; it is their default org iff
   * they had no prior membership. Mints the workspace id (Email-Ops becomes an
   * org minter for native orgs) + a unique slug derived from the display name.
   */
  async createOrg(user: User, input: CreateOrgInput): Promise<MyWorkspace> {
    const displayName = input.displayName.trim();
    if (!displayName) throw new BadRequestException('A display name is required.');

    const userKey = MembershipService.membershipKey(user);
    const priorMemberships = await this.membership.listActiveMemberships(user);
    const isDefault = priorMemberships.length === 0;

    const id = randomUUID();
    const slug = await this.uniqueSlug(input.slug?.trim() || displayName);

    const workspace = await this.prisma.workspace.create({
      data: { id, slug, displayName },
    });
    await this.prisma.membership.create({
      data: {
        userKey,
        workspaceId: workspace.id,
        role: WorkspaceRole.OWNER,
        status: MembershipStatus.ACTIVE,
        isDefault,
      },
    });

    return {
      workspace_id: workspace.id,
      slug: workspace.slug,
      display_name: workspace.displayName,
      role: roleToWire(WorkspaceRole.OWNER),
      is_default: isDefault,
    };
  }

  /** Rename an org (display name). ADMIN+. */
  async renameOrg(workspaceId: string, user: User, displayName: string): Promise<MyWorkspace> {
    const role = await this.requireRole(workspaceId, user, WorkspaceRole.ADMIN);
    const name = displayName.trim();
    if (!name) throw new BadRequestException('A display name is required.');
    const ws = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { displayName: name },
    });
    const mine = await this.callerMembership(workspaceId, user);
    return {
      workspace_id: ws.id,
      slug: ws.slug,
      display_name: ws.displayName,
      role: roleToWire(role),
      is_default: mine?.isDefault ?? false,
    };
  }

  // ── members ─────────────────────────────────────────────────────────────

  /** The org roster. Any active member may view. */
  async listMembers(workspaceId: string, user: User): Promise<MemberView[]> {
    await this.requireMember(workspaceId, user);
    const callerKeys = new Set(this.callerKeys(user));

    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });
    const users = await this.usersByKey(memberships.map((m) => m.userKey));

    return memberships.map((m) => {
      const u = users.get(m.userKey);
      return {
        user_key: m.userKey,
        email: u?.email ?? null,
        display_name: u ? this.userDisplayName(u) : null,
        role: roleToWire(m.role),
        status: statusToWire(m.status),
        is_default: m.isDefault,
        is_self: callerKeys.has(m.userKey),
        created_at: m.createdAt.toISOString(),
      };
    });
  }

  /** Change a member's role/status. ADMIN+. Cannot act on a higher-ranked member,
   * cannot grant above the caller's own rank, cannot strand the org with 0
   * active owners. Returns null when the target isn't in the org (→ 404). */
  async updateMember(
    workspaceId: string,
    user: User,
    targetUserKey: string,
    patch: UpdateMemberInput,
  ): Promise<MemberView | null> {
    const callerRole = await this.requireRole(workspaceId, user, WorkspaceRole.ADMIN);

    const target = await this.prisma.membership.findUnique({
      where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
    });
    if (!target) return null;

    // An admin cannot act on someone who outranks them (e.g. demote an owner).
    if (!this.callerKeys(user).includes(targetUserKey) && roleRank(target.role) > roleRank(callerRole)) {
      throw new ForbiddenException('Cannot modify a member with a higher role than yours.');
    }
    if (patch.role !== undefined && roleRank(patch.role) > roleRank(callerRole)) {
      throw new ForbiddenException('Cannot grant a role above your own.');
    }

    const data: Prisma.MembershipUpdateInput = {
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    // Last-owner protection — the count check + the write run in ONE transaction
    // that LOCKS the active-owner rows (FOR UPDATE), so two concurrent owner-
    // affecting changes serialize and can't both pass the check (the TOCTOU race).
    // The target is re-read under the lock (its role/status may have moved).
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockActiveOwners(tx, workspaceId);
      const fresh = await tx.membership.findUnique({
        where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
      });
      if (!fresh) return null;
      const losesOwner =
        fresh.role === WorkspaceRole.OWNER &&
        fresh.status === MembershipStatus.ACTIVE &&
        ((patch.role !== undefined && patch.role !== WorkspaceRole.OWNER) ||
          (patch.status !== undefined && patch.status !== MembershipStatus.ACTIVE));
      if (losesOwner && (await this.activeOwnerCount(workspaceId, tx)) <= 1) {
        throw new BadRequestException('An organization must keep at least one active owner.');
      }
      return tx.membership.update({
        where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
        data,
      });
    });
    if (!updated) return null;
    const u = (await this.usersByKey([targetUserKey])).get(targetUserKey);
    return {
      user_key: updated.userKey,
      email: u?.email ?? null,
      display_name: u ? this.userDisplayName(u) : null,
      role: roleToWire(updated.role),
      status: statusToWire(updated.status),
      is_default: updated.isDefault,
      is_self: this.callerKeys(user).includes(targetUserKey),
      created_at: updated.createdAt.toISOString(),
    };
  }

  /** Remove a member. ADMIN+ to remove others; any member may remove THEMSELVES
   * (leave the org). Cannot remove the last active owner. False → 404. */
  async removeMember(workspaceId: string, user: User, targetUserKey: string): Promise<boolean> {
    const isSelf = this.callerKeys(user).includes(targetUserKey);
    const callerRole = isSelf
      ? await this.requireMember(workspaceId, user)
      : await this.requireRole(workspaceId, user, WorkspaceRole.ADMIN);

    const target = await this.prisma.membership.findUnique({
      where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
    });
    if (!target) return false;

    if (!isSelf && roleRank(target.role) > roleRank(callerRole)) {
      throw new ForbiddenException('Cannot remove a member with a higher role than yours.');
    }

    // Last-owner protection — atomic check + delete under the active-owner lock.
    return this.prisma.$transaction(async (tx) => {
      await this.lockActiveOwners(tx, workspaceId);
      const fresh = await tx.membership.findUnique({
        where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
      });
      if (!fresh) return false;
      if (
        fresh.role === WorkspaceRole.OWNER &&
        fresh.status === MembershipStatus.ACTIVE &&
        (await this.activeOwnerCount(workspaceId, tx)) <= 1
      ) {
        throw new BadRequestException('An organization must keep at least one active owner.');
      }
      await tx.membership.delete({
        where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
      });
      return true;
    });
  }

  // ── invitations (admin surface) ──────────────────────────────────────────

  /** Invite an email into the org at a role. ADMIN+; cannot invite above the
   * caller's own rank. Re-inviting a still-pending email refreshes that invite. */
  async invite(workspaceId: string, user: User, input: InviteInput): Promise<InviteView> {
    const callerRole = await this.requireRole(workspaceId, user, WorkspaceRole.ADMIN);
    const role = input.role ?? WorkspaceRole.MEMBER;
    if (roleRank(role) > roleRank(callerRole)) {
      throw new ForbiddenException('Cannot invite at a role above your own.');
    }
    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new BadRequestException('A valid email address is required.');
    }

    // If that email already maps to ANY membership, there is nothing to invite —
    // including a SUSPENDED/REVOKED one: re-inviting must not be a back door that
    // silently reactivates a deliberately-suspended member at their old role.
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      const keys = [
        MembershipService.membershipKey(existingUser),
        existingUser.id,
        existingUser.keycloakId ?? '',
      ].filter(Boolean);
      const member = await this.prisma.membership.findFirst({
        where: { workspaceId, userKey: { in: keys } },
      });
      if (member) {
        throw new BadRequestException(
          member.status === MembershipStatus.ACTIVE
            ? 'That person is already a member of this organization.'
            : 'That person already has a suspended/revoked membership — reactivate them in the members list instead of re-inviting.',
        );
      }
    }

    const invitedByKey = MembershipService.membershipKey(user);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const pending = await this.prisma.invitation.findFirst({
      where: { workspaceId, email, status: InvitationStatus.PENDING },
    });
    const invite = pending
      ? await this.prisma.invitation.update({
          where: { id: pending.id },
          data: { role, token, invitedByKey, createdAt: new Date(), expiresAt },
        })
      : await this.prisma.invitation.create({
          data: { workspaceId, email, role, token, invitedByKey, expiresAt },
        });

    return this.toInviteView(invite, true);
  }

  /** Pending invitations for an org. ADMIN+. Includes the token (copy-link). */
  async listInvites(workspaceId: string, user: User): Promise<InviteView[]> {
    await this.requireRole(workspaceId, user, WorkspaceRole.ADMIN);
    const invites = await this.prisma.invitation.findMany({
      where: { workspaceId, status: InvitationStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(invites.map((i) => this.toInviteView(i, true)));
  }

  /** Revoke a pending invitation. ADMIN+. False → 404. */
  async revokeInvite(workspaceId: string, user: User, inviteId: string): Promise<boolean> {
    await this.requireRole(workspaceId, user, WorkspaceRole.ADMIN);
    const invite = await this.prisma.invitation.findFirst({
      where: { id: inviteId, workspaceId },
    });
    if (!invite) return false;
    if (invite.status === InvitationStatus.PENDING) {
      await this.prisma.invitation.update({
        where: { id: invite.id },
        data: { status: InvitationStatus.REVOKED },
      });
    }
    return true;
  }

  // ── invitations (invitee surface) ────────────────────────────────────────

  /** The caller's own pending invitations (matched by email, not expired). */
  async listMyInvites(user: User): Promise<MyInviteView[]> {
    const email = user.email.trim().toLowerCase();
    if (!email) return [];
    const invites = await this.prisma.invitation.findMany({
      where: { email, status: InvitationStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    const now = Date.now();
    const live = invites.filter((i) => !i.expiresAt || i.expiresAt.getTime() > now);
    if (live.length === 0) return [];

    const workspaces = await this.membership.findWorkspaces(live.map((i) => i.workspaceId));
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const inviters = await this.usersByKey(live.map((i) => i.invitedByKey));

    return live.map((i) => ({
      id: i.id,
      token: i.token,
      workspace_id: i.workspaceId,
      workspace_display_name: byId.get(i.workspaceId)?.displayName ?? i.workspaceId,
      role: roleToWire(i.role),
      invited_by_email: inviters.get(i.invitedByKey)?.email ?? null,
      created_at: i.createdAt.toISOString(),
      expires_at: i.expiresAt?.toISOString() ?? null,
    }));
  }

  /** Accept an invitation by its token → create the membership. Idempotent if the
   * caller is already a member. The token is the authorization (magic-link). */
  async acceptInvite(user: User, token: string): Promise<MyWorkspace> {
    const t = (token ?? '').trim();
    if (!t) throw new BadRequestException('An invitation token is required.');

    const invite = await this.prisma.invitation.findUnique({ where: { token: t } });
    if (!invite) throw new NotFoundException('That invitation could not be found.');
    if (invite.status !== InvitationStatus.PENDING) {
      throw new BadRequestException('That invitation is no longer valid.');
    }
    if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
      await this.prisma.invitation.update({
        where: { id: invite.id },
        data: { status: InvitationStatus.EXPIRED },
      });
      throw new BadRequestException('That invitation has expired.');
    }
    // Bind acceptance to the invited identity — a forwarded/leaked invite link
    // cannot be redeemed by a different account (critical for admin/owner-rank
    // invites). The /invites/mine surface already filters by email, so this only
    // tightens the token-accept path.
    if (invite.email.trim().toLowerCase() !== (user.email ?? '').trim().toLowerCase()) {
      throw new ForbiddenException('This invitation was issued to a different email address.');
    }

    const userKey = MembershipService.membershipKey(user);
    const existing = await this.prisma.membership.findFirst({
      where: { workspaceId: invite.workspaceId, userKey: { in: this.callerKeys(user) } },
    });
    if (!existing) {
      const priorMemberships = await this.membership.listActiveMemberships(user);
      await this.prisma.membership.create({
        data: {
          userKey,
          workspaceId: invite.workspaceId,
          role: invite.role,
          status: MembershipStatus.ACTIVE,
          isDefault: priorMemberships.length === 0,
        },
      });
    } else if (existing.status !== MembershipStatus.ACTIVE) {
      await this.prisma.membership.update({
        where: { userKey_workspaceId: { userKey: existing.userKey, workspaceId: invite.workspaceId } },
        data: { status: MembershipStatus.ACTIVE },
      });
    }

    await this.prisma.invitation.update({
      where: { id: invite.id },
      data: { status: InvitationStatus.ACCEPTED, acceptedByKey: userKey, acceptedAt: new Date() },
    });

    const ws = await this.prisma.workspace.findUnique({ where: { id: invite.workspaceId } });
    const mine = await this.callerMembership(invite.workspaceId, user);
    return {
      workspace_id: invite.workspaceId,
      slug: ws?.slug ?? invite.workspaceId,
      display_name: ws?.displayName ?? ws?.slug ?? invite.workspaceId,
      role: roleToWire(mine?.role ?? invite.role),
      is_default: mine?.isDefault ?? false,
    };
  }

  // ── RBAC + identity helpers ──────────────────────────────────────────────

  /** Every id this caller may be keyed by (keycloakId ?? id, plus both raw). */
  private callerKeys(user: User): string[] {
    return [...new Set([MembershipService.membershipKey(user), user.id, user.keycloakId ?? ''].filter(Boolean))];
  }

  /** The caller's ACTIVE membership in the org (resolved across the id ambiguity). */
  private async callerMembership(workspaceId: string, user: User) {
    return this.prisma.membership.findFirst({
      where: { workspaceId, userKey: { in: this.callerKeys(user) }, status: MembershipStatus.ACTIVE },
    });
  }

  /** The caller's real role, or null if they have no active membership. This is
   * the actual fence (independent of the permissive guard role pre-flag-flip). */
  private async resolveCallerRole(workspaceId: string, user: User): Promise<WorkspaceRole | null> {
    const m = await this.callerMembership(workspaceId, user);
    return m?.role ?? null;
  }

  /** Assert the caller is an active member; returns their role. 403 otherwise. */
  private async requireMember(workspaceId: string, user: User): Promise<WorkspaceRole> {
    const role = await this.resolveCallerRole(workspaceId, user);
    if (!role) throw new ForbiddenException('You are not a member of this organization.');
    return role;
  }

  /** Assert the caller is at least `min`; returns their role. 403 otherwise. */
  private async requireRole(workspaceId: string, user: User, min: WorkspaceRole): Promise<WorkspaceRole> {
    const role = await this.requireMember(workspaceId, user);
    if (!roleAtLeast(role, min)) {
      throw new ForbiddenException(`This action requires the ${String(min).toLowerCase()} role or higher.`);
    }
    return role;
  }

  /** Count of ACTIVE OWNER memberships (the last-owner guard). Pass the tx client
   * to count under the same transaction as the owner-row lock. */
  private async activeOwnerCount(
    workspaceId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    return client.membership.count({
      where: { workspaceId, role: WorkspaceRole.OWNER, status: MembershipStatus.ACTIVE },
    });
  }

  /** Lock the workspace's ACTIVE OWNER rows for the current transaction so a
   * concurrent owner-affecting write serializes behind it (closes the last-owner
   * TOCTOU race). A no-op when the org has no active owners. */
  private async lockActiveOwners(tx: Prisma.TransactionClient, workspaceId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT 1 FROM "memberships"
      WHERE "workspaceId" = ${workspaceId} AND "role"::text = 'OWNER' AND "status"::text = 'ACTIVE'
      FOR UPDATE`;
  }

  /** Load Users for a set of membership keys, indexed by the key that matched
   * (a key is either a keycloakId or a local User.id). */
  private async usersByKey(keys: string[]): Promise<Map<string, User>> {
    const unique = [...new Set(keys.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { OR: [{ keycloakId: { in: unique } }, { id: { in: unique } }] },
    });
    const byKey = new Map<string, User>();
    for (const k of unique) {
      const u = users.find((x) => x.keycloakId === k || x.id === k);
      if (u) byKey.set(k, u);
    }
    return byKey;
  }

  private userDisplayName(u: User): string {
    const full = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
    return full || u.username || u.email;
  }

  private async toInviteView(invite: Invitation, includeToken: boolean): Promise<InviteView> {
    const inviter = (await this.usersByKey([invite.invitedByKey])).get(invite.invitedByKey);
    return {
      id: invite.id,
      email: invite.email,
      role: roleToWire(invite.role),
      status: inviteStatusToWire(invite.status),
      invited_by_email: inviter?.email ?? null,
      token: includeToken ? invite.token : null,
      created_at: invite.createdAt.toISOString(),
      expires_at: invite.expiresAt?.toISOString() ?? null,
      accepted_at: invite.acceptedAt?.toISOString() ?? null,
    };
  }

  // ── slug minting ─────────────────────────────────────────────────────────

  /** A URL-safe, unique slug derived from a seed (display name or explicit slug). */
  private async uniqueSlug(seed: string): Promise<string> {
    const base =
      seed
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'org';
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.workspace.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
    }
    return `${base}-${randomBytes(3).toString('hex')}`;
  }
}
