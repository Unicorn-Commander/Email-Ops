'use client';

/**
 * "Pending invitations" — the invitee-facing accept surface.
 *
 * Opened from the Top-bar switcher's "N pending invitations" row, it lists the
 * orgs that have invited the caller (from `/invites/mine`, seeded by the switcher
 * so there is no load flash) and accepts one by its single-use token. On accept
 * we land the UI IN the joined org — `refresh()` pulls it into the org list, then
 * `setActiveWorkspaceId(...)` switches the whole app to it (mirroring create-org).
 * The accepted row is dropped; the dialog closes once none remain.
 */

import { useState } from 'react';
import { Badge, Button, Dialog } from '@/components/ui';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { ApiError } from '@/lib/api';
import { acceptInvite, type MyInviteView, type WorkspaceRole } from '@/lib/workspacesApi';

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Title-case a wire role for display (e.g. `manager` → `Manager`). */
function roleLabel(role: WorkspaceRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function AcceptInvitesDialog({
  invites: initial,
  onClose,
}: {
  /** The caller's pending invitations, already fetched by the switcher. */
  invites: MyInviteView[];
  onClose: () => void;
}) {
  const { refresh, setActiveWorkspaceId } = useActiveWorkspace();
  const [invites, setInvites] = useState<MyInviteView[]>(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept(invite: MyInviteView) {
    setBusyId(invite.id);
    setError(null);
    try {
      const res = await acceptInvite({ token: invite.token });
      // Join + land in the org: refresh the list, then switch to it.
      await refresh();
      setActiveWorkspaceId(res.workspace.workspace_id);
      const remaining = invites.filter((i) => i.id !== invite.id);
      setInvites(remaining);
      if (remaining.length === 0) {
        onClose();
        return;
      }
    } catch (err) {
      setError(messageOf(err, 'Could not accept the invitation.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && busyId === null) onClose();
      }}
      title="Pending invitations"
      description="Organizations that have invited you. Accepting adds you as a member."
      footer={
        <Button variant="secondary" size="sm" disabled={busyId !== null} onClick={onClose}>
          Close
        </Button>
      }
    >
      {invites.length === 0 ? (
        <p className="text-xs text-muted">You have no pending invitations.</p>
      ) : (
        <ul className="space-y-2">
          {invites.map((invite) => (
            <li
              key={invite.id}
              className="flex items-center gap-3 rounded-token border border-subtle bg-surface-base/40 p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-primary">
                    {invite.workspace_display_name}
                  </span>
                  <Badge variant="info">{roleLabel(invite.role)}</Badge>
                </div>
                {invite.invited_by_email && (
                  <span className="mt-0.5 block truncate text-[11px] text-muted">
                    invited by {invite.invited_by_email}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                className="shrink-0"
                disabled={busyId !== null}
                onClick={() => void accept(invite)}
              >
                {busyId === invite.id ? 'Accepting…' : 'Accept'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
    </Dialog>
  );
}
