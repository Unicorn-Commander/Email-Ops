'use client';

/**
 * "Members" — manage who belongs to an org and what they can do.
 *
 * Mirrors the calm visual language of `ManageSpacesDialog`: a sectioned modal
 * (members · pending invitations · invite form) with role badges + inline errors.
 * It is mounted only while open, so its fetch of `/members` (+ `/invites` for
 * admins) is lazy. Admin actions — change a member's role, remove a member,
 * revoke or send an invitation — are gated on the caller's ACTUAL role (passed in
 * via the active org's `MyWorkspace.role`); a non-admin sees a read-only roster.
 *
 * RBAC mirrors the backend so the UI never offers what the server will refuse:
 * the role pickers cap at the caller's own rank ("cannot grant above your rank"),
 * and a member at a higher rank than the caller is read-only. The last-active-
 * OWNER protections are enforced server-side and surface inline. A change that
 * affects the caller themselves (their role, or leaving) refreshes the ambient
 * org list so the rest of the chrome re-scopes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Dialog, Input, Select, useConfirm, type BadgeVariant } from '@/components/ui';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { ApiError, type MyWorkspace } from '@/lib/api';
import {
  createInvite,
  isAdminRole,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
  roleRank,
  updateMember,
  WORKSPACE_ROLES,
  type InviteView,
  type MemberView,
  type MembershipStatus,
  type WorkspaceRole,
} from '@/lib/workspacesApi';

type Load = 'loading' | 'ready' | 'error';

/** Role → badge tone (single source of truth). */
const ROLE_TONE: Record<WorkspaceRole, BadgeVariant> = {
  viewer: 'neutral',
  member: 'info',
  manager: 'accent',
  admin: 'protected',
  owner: 'success',
};

/** Non-active membership status → badge tone. */
const STATUS_TONE: Record<MembershipStatus, BadgeVariant> = {
  active: 'success',
  suspended: 'warning',
  revoked: 'danger',
};

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Title-case a wire role for display (e.g. `manager` → `Manager`). */
function roleLabel(role: WorkspaceRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function ManageMembersDialog({
  workspace,
  onClose,
}: {
  /** The active org (carries the caller's own role, which gates admin actions). */
  workspace: MyWorkspace;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const { refresh: refreshOrgs } = useActiveWorkspace();
  const workspaceId = workspace.workspace_id;
  const callerRank = roleRank(workspace.role);
  const isAdmin = isAdminRole(workspace.role);

  const [members, setMembers] = useState<MemberView[]>([]);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);

  // Per-row mutation state (members + invites share one busy key / error line).
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Invite form.
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  /** Fetch the roster (+ invites, which are admin-only). `silent` skips the flash. */
  const fetchAll = useCallback(
    async (silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const memberRes = await listMembers(workspaceId);
        const inviteRes = isAdmin ? await listInvites(workspaceId) : { invites: [] };
        setMembers(memberRes.members);
        setInvites(inviteRes.invites);
        setError(null);
        setLoad('ready');
      } catch (err) {
        setError(messageOf(err, 'Could not load members.'));
        setLoad('error');
      }
    },
    [workspaceId, isAdmin],
  );

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // The roles the caller may assign — never above their own rank.
  const assignableRoles = useMemo(
    () => WORKSPACE_ROLES.filter((r) => roleRank(r) <= callerRank),
    [callerRank],
  );

  const pendingInvites = useMemo(
    () => invites.filter((invite) => invite.status === 'pending'),
    [invites],
  );

  async function changeRole(member: MemberView, role: WorkspaceRole) {
    if (role === member.role) return;
    setRowBusy(member.user_key);
    setRowError(null);
    try {
      await updateMember(workspaceId, member.user_key, { role });
      await fetchAll(true);
      if (member.is_self) await refreshOrgs(); // the caller's own rank changed
    } catch (err) {
      setRowError(messageOf(err, 'Could not change the role.'));
    } finally {
      setRowBusy(null);
    }
  }

  async function handleRemove(member: MemberView) {
    const who = member.display_name || member.email || member.user_key;
    const ok = await confirm({
      title: member.is_self ? 'Leave this organization?' : `Remove ${who}?`,
      description: member.is_self
        ? 'You will lose access to this organization’s mailboxes, agents and spaces.'
        : 'They lose access immediately. This does not delete any mail.',
      confirmLabel: member.is_self ? 'Leave' : 'Remove',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    setRowBusy(member.user_key);
    setRowError(null);
    try {
      await removeMember(workspaceId, member.user_key);
      if (member.is_self) {
        // Left the org — refresh the org list (the provider reconciles the active one).
        await refreshOrgs();
        onClose();
        return;
      }
      await fetchAll(true);
    } catch (err) {
      setRowError(messageOf(err, 'Could not remove the member.'));
    } finally {
      setRowBusy(null);
    }
  }

  async function handleRevoke(invite: InviteView) {
    setRowBusy(invite.id);
    setRowError(null);
    try {
      await revokeInvite(workspaceId, invite.id);
      await fetchAll(true);
    } catch (err) {
      setRowError(messageOf(err, 'Could not revoke the invitation.'));
    } finally {
      setRowBusy(null);
    }
  }

  async function handleInvite() {
    const email = inviteEmail.trim();
    if (!email) {
      setInviteError('An email is required.');
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      await createInvite(workspaceId, { email, role: inviteRole });
      setInviteEmail('');
      setInviteRole('member');
      await fetchAll(true);
    } catch (err) {
      setInviteError(messageOf(err, 'Could not send the invitation.'));
    } finally {
      setInviting(false);
    }
  }

  const busy = rowBusy !== null || inviting;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="Members"
      description={`Manage who belongs to ${workspace.display_name} and what they can do.`}
      className="max-w-2xl"
      footer={
        <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Members ------------------------------------------------------------ */}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-tertiary">Members</h3>
            <span className="font-mono text-[11px] text-muted">{members.length}</span>
          </div>
          {load === 'loading' ? (
            <p className="px-1 py-2 text-xs text-muted">Loading members…</p>
          ) : load === 'error' ? (
            <p className="px-1 py-2 text-xs text-danger">{error}</p>
          ) : (
            <ul className="space-y-1">
              {members.map((member) => (
                <MemberRow
                  key={member.user_key}
                  member={member}
                  isAdmin={isAdmin}
                  callerRank={callerRank}
                  assignableRoles={assignableRoles}
                  busy={rowBusy === member.user_key}
                  onChangeRole={(role) => void changeRole(member, role)}
                  onRemove={() => void handleRemove(member)}
                />
              ))}
            </ul>
          )}
          {rowError && <p className="px-1 text-xs text-danger">{rowError}</p>}
        </section>

        {/* Pending invitations + invite form (admins only) ------------------- */}
        {isAdmin && (
          <>
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-tertiary">
                  Pending invitations
                </h3>
                <span className="font-mono text-[11px] text-muted">{pendingInvites.length}</span>
              </div>
              {pendingInvites.length === 0 ? (
                <p className="px-1 py-1 text-[11px] text-muted">No pending invitations.</p>
              ) : (
                <ul className="space-y-1">
                  {pendingInvites.map((invite) => (
                    <InviteRow
                      key={invite.id}
                      invite={invite}
                      busy={rowBusy === invite.id}
                      onRevoke={() => void handleRevoke(invite)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2 border-t border-subtle pt-4">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-tertiary">
                Invite someone
              </h3>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <Input
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="teammate@company.com"
                    autoComplete="off"
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleInvite();
                      }
                    }}
                  />
                </div>
                <Select
                  aria-label="Invite role"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}
                  className="sm:w-40"
                >
                  {assignableRoles.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </Select>
                <Button size="sm" disabled={inviting} onClick={() => void handleInvite()}>
                  {inviting ? 'Inviting…' : 'Send invite'}
                </Button>
              </div>
              {inviteError && <p className="text-xs text-danger">{inviteError}</p>}
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** One member row: identity · status · role (editable for admins) · remove/leave. */
function MemberRow({
  member,
  isAdmin,
  callerRank,
  assignableRoles,
  busy,
  onChangeRole,
  onRemove,
}: {
  member: MemberView;
  isAdmin: boolean;
  callerRank: number;
  assignableRoles: WorkspaceRole[];
  busy: boolean;
  onChangeRole: (role: WorkspaceRole) => void;
  onRemove: () => void;
}) {
  const name = member.display_name || member.email || member.user_key;
  // An admin may act on a member at or below their own rank (mirrors the backend).
  const canManage = isAdmin && roleRank(member.role) <= callerRank;

  return (
    <li className="flex items-center gap-2 rounded-token px-2 py-1.5 transition-colors duration-fast hover:bg-surface-overlay/50">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-overlay text-[11px] font-semibold text-secondary">
        {(name[0] ?? '?').toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-primary">{name}</span>
          {member.is_self && <span className="shrink-0 text-[10px] text-muted">you</span>}
        </div>
        {member.email && member.email !== name && (
          <span className="block truncate font-mono text-[10px] text-muted">{member.email}</span>
        )}
      </div>

      {member.status !== 'active' && (
        <Badge variant={STATUS_TONE[member.status]}>{member.status}</Badge>
      )}

      {canManage ? (
        <Select
          aria-label={`Role for ${name}`}
          value={member.role}
          disabled={busy}
          onChange={(event) => onChangeRole(event.target.value as WorkspaceRole)}
          className="w-28 shrink-0 text-xs"
        >
          {assignableRoles.map((role) => (
            <option key={role} value={role}>
              {roleLabel(role)}
            </option>
          ))}
        </Select>
      ) : (
        <Badge variant={ROLE_TONE[member.role]}>{roleLabel(member.role)}</Badge>
      )}

      {(canManage || member.is_self) && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2 text-[11px]"
          disabled={busy}
          onClick={onRemove}
        >
          {member.is_self ? 'Leave' : 'Remove'}
        </Button>
      )}
    </li>
  );
}

/** One pending-invitation row: email · invited-by · role · revoke. */
function InviteRow({
  invite,
  busy,
  onRevoke,
}: {
  invite: InviteView;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-token px-2 py-1.5 transition-colors duration-fast hover:bg-surface-overlay/50">
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-overlay text-sm text-tertiary"
      >
        @
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-primary">{invite.email}</span>
        {invite.invited_by_email && (
          <span className="block truncate text-[10px] text-muted">
            invited by {invite.invited_by_email}
          </span>
        )}
      </div>
      <Badge variant={ROLE_TONE[invite.role]}>{roleLabel(invite.role)}</Badge>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 px-2 text-[11px]"
        disabled={busy}
        onClick={onRevoke}
      >
        Revoke
      </Button>
    </li>
  );
}
