/**
 * Typed browser client for "Organizations" — the hard multi-tenant boundary.
 *
 * An Organization IS the existing `Workspace` (the tenancy seam every mailbox /
 * agent / space call is scoped to). Phase B layers create-org / switch-org /
 * invite / members(RBAC) on top of that foundation, so this module is the typed
 * surface over the new `@Controller('workspaces')` org routes plus the
 * invitee-facing `@Controller('invites')` routes.
 *
 * This module mirrors `lib/spacesApi.ts`: wire shapes are snake_case and typed
 * verbatim with no remapping, every org-scoped route carries the `:workspaceId`
 * tenancy segment, and it reuses the shared `apiGet`/`apiPost`/`apiPatch`/
 * `apiDelete` from `@/lib/api` (auth, error extraction, JSON) without ever
 * editing that file.
 *
 * RBAC is enforced server-side against the caller's ACTUAL membership role
 * (ADMIN+ for member/invite mutations; any active member may read). Denials
 * surface verbatim through `ApiError` (403 = not allowed, 404 = gone, 409 =
 * conflict) so callers can show them inline.
 */

import { apiDelete, apiGet, apiPatch, apiPost, type MyWorkspace } from '@/lib/api';

/** A member's capability tier within an org (wire). Ranked low→high by `ROLE_RANK`. */
export type WorkspaceRole = 'viewer' | 'member' | 'manager' | 'admin' | 'owner';

/** Lifecycle of a membership (wire). */
export type MembershipStatus = 'active' | 'suspended' | 'revoked';

/** Lifecycle of an invitation (wire). */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** Re-export the org wire shape so org callers can import it from one place. */
export type { MyWorkspace };

/** Low→high rank of each role — the one source of truth for "can grant up to". */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  manager: 2,
  admin: 3,
  owner: 4,
};

/** The roles in display order (low→high). */
export const WORKSPACE_ROLES: WorkspaceRole[] = ['viewer', 'member', 'manager', 'admin', 'owner'];

/** Rank a (possibly loosely-typed wire) role; an unknown role ranks lowest. */
export function roleRank(role: string | null | undefined): number {
  return role && role in ROLE_RANK ? ROLE_RANK[role as WorkspaceRole] : 0;
}

/** True when the role is ADMIN or OWNER — the gate for member/invite mutations. */
export function isAdminRole(role: string | null | undefined): boolean {
  return roleRank(role) >= ROLE_RANK.admin;
}

/** One member of an org (mirrors the backend MemberView wire shape; snake_case). */
export interface MemberView {
  /** Stable identity key — the Keycloak id, else the local User id. */
  user_key: string;
  email: string | null;
  display_name: string | null;
  role: WorkspaceRole;
  status: MembershipStatus;
  is_default: boolean;
  /** True when this row is the caller themselves. */
  is_self: boolean;
  created_at: string;
}

/** One admin-facing invitation within an org (mirrors InviteView). */
export interface InviteView {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  invited_by_email: string | null;
  /** Present to admins (for the copy-link); null otherwise. */
  token: string | null;
  created_at: string;
  expires_at: string | null;
  accepted_at: string | null;
}

/** One invitee-facing invitation (mirrors MyInviteView). */
export interface MyInviteView {
  id: string;
  token: string;
  workspace_id: string;
  workspace_display_name: string;
  role: WorkspaceRole;
  invited_by_email: string | null;
  created_at: string;
  expires_at: string | null;
}

/** Body for creating an org. The caller becomes its OWNER. */
export interface CreateOrgBody {
  display_name: string;
  /** Optional desired slug; the server slugifies + de-dupes if omitted/taken. */
  slug?: string;
}

/** Body for renaming an org (ADMIN+). */
export interface UpdateOrgBody {
  display_name?: string;
}

/** Body for changing a member's role / status (ADMIN+). */
export interface UpdateMemberBody {
  role?: WorkspaceRole;
  status?: MembershipStatus;
}

/** Body for inviting an email to an org (ADMIN+). Role defaults to `member`. */
export interface CreateInviteBody {
  email: string;
  role?: WorkspaceRole;
}

/** Body for accepting an invitation by its single-use token. */
export interface AcceptInviteBody {
  token: string;
}

const seg = encodeURIComponent;

const orgBase = (workspaceId: string) => `/workspaces/${seg(workspaceId)}`;

// ── Org-level ───────────────────────────────────────────────────────────────

/**
 * Create an org. The caller becomes its OWNER (and its default org iff they had
 * no prior membership). Returns the new org as a `MyWorkspace` (201).
 */
export async function createOrg(body: CreateOrgBody, token?: string): Promise<MyWorkspace> {
  return apiPost<MyWorkspace>('/workspaces', body, token);
}

/** List the caller's orgs (alias of `GET /auth/me/workspaces`). */
export async function listMyOrgs(token?: string): Promise<{ workspaces: MyWorkspace[] }> {
  return apiGet<{ workspaces: MyWorkspace[] }>('/workspaces', token);
}

/** Rename an org (ADMIN+ → 403 otherwise). Returns the refreshed org. */
export async function updateOrg(
  workspaceId: string,
  body: UpdateOrgBody,
  token?: string,
): Promise<MyWorkspace> {
  return apiPatch<MyWorkspace>(orgBase(workspaceId), body, token);
}

// ── Members (org-scoped) ────────────────────────────────────────────────────

/** List an org's members (any active member). */
export async function listMembers(
  workspaceId: string,
  token?: string,
): Promise<{ members: MemberView[] }> {
  return apiGet<{ members: MemberView[] }>(`${orgBase(workspaceId)}/members`, token);
}

/**
 * Change a member's role / status (ADMIN+). The server refuses to leave the org
 * with zero active OWNERs and refuses to grant a role above the caller's own
 * rank (both surface as `ApiError`). Returns the refreshed member.
 */
export async function updateMember(
  workspaceId: string,
  userKey: string,
  body: UpdateMemberBody,
  token?: string,
): Promise<MemberView> {
  return apiPatch<MemberView>(`${orgBase(workspaceId)}/members/${seg(userKey)}`, body, token);
}

/** Remove a member (ADMIN+, or self-removal). Cannot remove the last active OWNER. */
export async function removeMember(
  workspaceId: string,
  userKey: string,
  token?: string,
): Promise<{ removed: true }> {
  return apiDelete<{ removed: true }>(`${orgBase(workspaceId)}/members/${seg(userKey)}`, token);
}

// ── Invitations (org-scoped, ADMIN+) ────────────────────────────────────────

/** List an org's invitations (ADMIN+). */
export async function listInvites(
  workspaceId: string,
  token?: string,
): Promise<{ invites: InviteView[] }> {
  return apiGet<{ invites: InviteView[] }>(`${orgBase(workspaceId)}/invites`, token);
}

/**
 * Invite an email to an org (ADMIN+). Role defaults to `member` and cannot
 * exceed the caller's rank. Re-inviting a still-pending email refreshes it.
 */
export async function createInvite(
  workspaceId: string,
  body: CreateInviteBody,
  token?: string,
): Promise<InviteView> {
  return apiPost<InviteView>(`${orgBase(workspaceId)}/invites`, body, token);
}

/** Revoke a pending invitation (ADMIN+). */
export async function revokeInvite(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<{ revoked: true }> {
  return apiDelete<{ revoked: true }>(`${orgBase(workspaceId)}/invites/${seg(id)}`, token);
}

// ── Invitee-facing ──────────────────────────────────────────────────────────

/** The caller's pending invitations (by email, case-insensitive, not expired). */
export async function listMyInvites(token?: string): Promise<{ invites: MyInviteView[] }> {
  return apiGet<{ invites: MyInviteView[] }>('/invites/mine', token);
}

/**
 * Accept an invitation by token — creates the membership (role from the invite)
 * and marks it accepted. Idempotent if already a member. Returns the joined org.
 */
export async function acceptInvite(
  body: AcceptInviteBody,
  token?: string,
): Promise<{ workspace: MyWorkspace }> {
  return apiPost<{ workspace: MyWorkspace }>('/invites/accept', body, token);
}
