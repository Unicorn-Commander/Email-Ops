'use client';

/**
 * "Create organization" — a single-field modal that mints a new tenant.
 *
 * A name is all the backend needs: it slugifies + de-dupes the slug, makes the
 * caller the OWNER, and (iff they had no prior membership) flags it default. On
 * success we land the UI IN the new org — `refresh()` pulls it into the org list,
 * then `setActiveWorkspaceId(newId)` switches the whole app to it (mirroring the
 * accept-invite flow). The 4xx surfaced by the backend appears inline.
 */

import { useState } from 'react';
import { Button, Dialog, Input } from '@/components/ui';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { ApiError } from '@/lib/api';
import { createOrg } from '@/lib/workspacesApi';

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function CreateOrgDialog({ onClose }: { onClose: () => void }) {
  const { refresh, setActiveWorkspaceId } = useActiveWorkspace();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('A name is required.');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const ws = await createOrg({ display_name: trimmed });
      // Land in the new org: refresh the list, then switch to it.
      await refresh();
      setActiveWorkspaceId(ws.workspace_id);
      onClose();
    } catch (err) {
      setFormError(messageOf(err, 'Could not create the organization.'));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="Create organization"
      description="An organization is a separate tenant — its own mailboxes, agents, members and spaces."
      footer={
        <>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void handleCreate()}>
            {busy ? 'Creating…' : 'Create organization'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-tertiary">Organization name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Acme Inc."
            autoFocus
            autoComplete="off"
          />
          <span className="mt-1 block text-[11px] leading-5 text-muted">
            You&rsquo;ll be its owner. A URL slug is generated automatically.
          </span>
        </label>

        {formError && <p className="text-xs text-danger">{formError}</p>}
      </form>
    </Dialog>
  );
}
