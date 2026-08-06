/**
 * Wire + service types for the multi-org tenancy surface (create-org / switch /
 * invite / members). Wire JSON is snake_case (the suite interchange vocabulary);
 * service inputs are camelCase. The org list shape itself (`MyWorkspace`) is the
 * existing `list_my_workspaces` projection — reused verbatim so create-org and
 * `GET /auth/me/workspaces` return the identical shape.
 */

import {
  InvitationStatus,
  MembershipStatus,
  WorkspaceRole,
} from '@prisma/client';

export type WorkspaceRoleWire = 'viewer' | 'member' | 'manager' | 'admin' | 'owner';
export type MembershipStatusWire = 'active' | 'suspended' | 'revoked';
export type InvitationStatusWire = 'pending' | 'accepted' | 'revoked' | 'expired';

/** A member of a workspace (the per-org RBAC roster). */
export interface MemberView {
  /** == keycloakId ?? User.id (the Membership key). */
  user_key: string;
  /** Resolved from the User row when present (a seeded key may have no User yet). */
  email: string | null;
  display_name: string | null;
  role: WorkspaceRoleWire;
  status: MembershipStatusWire;
  is_default: boolean;
  /** True when this row is the caller. */
  is_self: boolean;
  created_at: string;
}

/** A pending invitation, admin-facing (within an org). `token` is exposed to
 * admins so the UI can offer a copyable invite link. */
export interface InviteView {
  id: string;
  email: string;
  role: WorkspaceRoleWire;
  status: InvitationStatusWire;
  invited_by_email: string | null;
  token: string | null;
  created_at: string;
  expires_at: string | null;
  accepted_at: string | null;
}

/** An invitation as seen by the INVITEE (resolves the org name to accept into). */
export interface MyInviteView {
  id: string;
  token: string;
  workspace_id: string;
  workspace_display_name: string;
  role: WorkspaceRoleWire;
  invited_by_email: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface CreateOrgInput {
  displayName: string;
  slug?: string;
}

export interface InviteInput {
  email: string;
  role?: WorkspaceRole;
}

export interface UpdateMemberInput {
  role?: WorkspaceRole;
  status?: MembershipStatus;
}

// ── wire ⇄ enum mappers (the one place the casing crosses the boundary) ──────

export function roleToWire(role: WorkspaceRole): WorkspaceRoleWire {
  return String(role).toLowerCase() as WorkspaceRoleWire;
}

export function roleFromWire(wire: WorkspaceRoleWire): WorkspaceRole {
  switch (wire) {
    case 'viewer':
      return WorkspaceRole.VIEWER;
    case 'member':
      return WorkspaceRole.MEMBER;
    case 'manager':
      return WorkspaceRole.MANAGER;
    case 'admin':
      return WorkspaceRole.ADMIN;
    case 'owner':
      return WorkspaceRole.OWNER;
  }
}

export function statusToWire(status: MembershipStatus): MembershipStatusWire {
  return String(status).toLowerCase() as MembershipStatusWire;
}

export function statusFromWire(wire: MembershipStatusWire): MembershipStatus {
  switch (wire) {
    case 'active':
      return MembershipStatus.ACTIVE;
    case 'suspended':
      return MembershipStatus.SUSPENDED;
    case 'revoked':
      return MembershipStatus.REVOKED;
  }
}

export function inviteStatusToWire(status: InvitationStatus): InvitationStatusWire {
  return String(status).toLowerCase() as InvitationStatusWire;
}
