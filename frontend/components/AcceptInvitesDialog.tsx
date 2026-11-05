'use client';

/**
 * "Pending invitations" — the invitee-facing accept surface.
 *
 * Opened from the Top-bar switcher's "N pending invitations" row, it lists the
 * orgs that have invited the caller (from `/invites/mine`, seeded by the switcher
 * so there is no load flash). Raw capabilities are not returned by that listing;
 * the invitee accepts from the one-time link sent by the workspace admin.
 */

import { Badge, Button, Dialog } from '@/components/ui';
import { type MyInviteView, type WorkspaceRole } from '@/lib/workspacesApi';

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
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Pending invitations"
      description="Open the one-time invitation link from your workspace admin to accept."
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      {initial.length === 0 ? (
        <p className="text-xs text-muted">You have no pending invitations.</p>
      ) : (
        <ul className="space-y-2">
          {initial.map((invite) => (
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
              <span className="shrink-0 text-right text-[10px] text-muted">
                Use the shared link
              </span>
            </li>
          ))}
        </ul>
      )}

    </Dialog>
  );
}
