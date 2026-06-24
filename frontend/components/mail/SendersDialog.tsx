'use client';

/**
 * "Blocked & trusted senders" — manage the workspace's sender block/allow list.
 *
 * Opens from a "Manage senders" button in the thread-list pane. On open it
 * fetches the workspace's sender policies and shows two groups — Blocked (kind
 * BLOCK) and Trusted (kind ALLOW) — each row with a remove (×). An add form
 * creates a rule (Address/Domain × Block/Trust, with an optional reason).
 *
 * Degrade-clean: an empty list is just empty (most workspaces start with none),
 * and a failed fetch shows a calm inline message with a retry rather than an
 * alarming error. Mutations refetch so the two groups always reflect the truth.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { Badge, Button, Dialog, Input, Select } from '@/components/ui';
import {
  listSenderPolicies,
  removeSenderPolicy,
  setSenderPolicy,
  type SenderKind,
  type SenderPolicyView,
  type SenderScope,
} from '@/lib/mailApi';

type Load = 'loading' | 'ready' | 'error';

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function SendersDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  /** The active workspace — null only briefly while it resolves. */
  workspaceId: string | null;
}) {
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);
  const [policies, setPolicies] = useState<SenderPolicyView[]>([]);

  // Add-form state.
  const [scope, setScope] = useState<SenderScope>('ADDRESS');
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState<SenderKind>('BLOCK');
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Tracks the row currently being removed (disables just that ×).
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setPolicies([]);
      setLoad('ready');
      return;
    }
    setLoad('loading');
    try {
      const res = await listSenderPolicies(workspaceId);
      setPolicies(res.items);
      setError(null);
      setLoad('ready');
    } catch (err) {
      setError(messageOf(err, 'Could not load your sender list.'));
      setLoad('error');
    }
  }, [workspaceId]);

  // (Re)load on open, and reset the add form.
  useEffect(() => {
    if (!open) return;
    setScope('ADDRESS');
    setPattern('');
    setKind('BLOCK');
    setReason('');
    setFormError(null);
    setAdding(false);
    setRemovingId(null);
    void refresh();
  }, [open, refresh]);

  function handleOpenChange(next: boolean) {
    if (!next && !adding) onClose();
  }

  const canAdd = pattern.trim().length > 0 && !adding && !!workspaceId;

  async function handleAdd() {
    if (!workspaceId) {
      setFormError('No workspace selected.');
      return;
    }
    const value = pattern.trim();
    if (!value) {
      setFormError('Enter an address or domain.');
      return;
    }
    setAdding(true);
    setFormError(null);
    try {
      await setSenderPolicy(workspaceId, {
        scope,
        pattern: value,
        kind,
        reason: reason.trim() || undefined,
      });
      setPattern('');
      setReason('');
      await refresh();
    } catch (err) {
      setFormError(messageOf(err, 'Could not add this rule.'));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id: string) {
    if (!workspaceId) return;
    setRemovingId(id);
    setFormError(null);
    try {
      await removeSenderPolicy(workspaceId, id);
      await refresh();
    } catch (err) {
      // A 404 means it's already gone — treat as removed and just refresh.
      if (err instanceof ApiError && err.status === 404) {
        await refresh();
      } else {
        setFormError(messageOf(err, 'Could not remove this rule.'));
      }
    } finally {
      setRemovingId(null);
    }
  }

  const blocked = policies.filter((p) => p.kind === 'BLOCK');
  const trusted = policies.filter((p) => p.kind === 'ALLOW');

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Blocked & trusted senders"
      description="Block a sender to keep their mail out, or trust one so it never lands in spam."
      className="max-w-lg"
      footer={
        <Button variant="secondary" size="sm" onClick={() => handleOpenChange(false)}>
          Done
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Add form */}
        <form
          className="space-y-3 rounded-token border border-subtle bg-surface-base/40 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAdd();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Scope</span>
              <Select
                value={scope}
                onChange={(e) => setScope(e.target.value as SenderScope)}
                aria-label="Scope"
              >
                <option value="ADDRESS">Address</option>
                <option value="DOMAIN">Domain</option>
              </Select>
            </label>
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">
                {scope === 'DOMAIN' ? 'Domain' : 'Address'}
              </span>
              <Input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={scope === 'DOMAIN' ? 'example.com' : 'name@example.com'}
                autoComplete="off"
                spellCheck={false}
                inputMode="email"
              />
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Action</span>
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as SenderKind)}
                aria-label="Action"
              >
                <option value="BLOCK">Block</option>
                <option value="ALLOW">Trust</option>
              </Select>
            </label>
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">
                Reason (optional)
              </span>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why?"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            {formError ? (
              <p className="min-w-0 flex-1 text-xs text-danger">{formError}</p>
            ) : (
              <span className="min-w-0 flex-1 text-[11px] text-muted">
                {scope === 'DOMAIN'
                  ? 'Applies to everyone at that domain.'
                  : 'Applies to that exact address.'}
              </span>
            )}
            <Button size="sm" disabled={!canAdd} onClick={() => void handleAdd()}>
              {adding ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </form>

        {/* Lists */}
        {load === 'loading' ? (
          <p className="px-1 py-4 text-center text-sm text-tertiary">Loading your sender list…</p>
        ) : load === 'error' ? (
          <div className="px-1 py-2">
            <p className="text-sm font-medium text-primary">Could not load your sender list.</p>
            <p className="mt-1 text-xs text-danger">{error ?? 'Unknown error.'}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <PolicyGroup
              title="Blocked"
              tone="danger"
              emptyLabel="No blocked senders."
              policies={blocked}
              removingId={removingId}
              onRemove={(id) => void handleRemove(id)}
            />
            <PolicyGroup
              title="Trusted"
              tone="success"
              emptyLabel="No trusted senders."
              policies={trusted}
              removingId={removingId}
              onRemove={(id) => void handleRemove(id)}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function PolicyGroup({
  title,
  tone,
  emptyLabel,
  policies,
  removingId,
  onRemove,
}: {
  title: string;
  tone: 'danger' | 'success';
  emptyLabel: string;
  policies: SenderPolicyView[];
  removingId: string | null;
  onRemove: (id: string) => void;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-tertiary">
          {title}
        </span>
        <span className="font-mono text-[11px] text-muted">{policies.length}</span>
      </div>
      {policies.length === 0 ? (
        <p className="rounded-token border border-subtle bg-surface-base/30 px-3 py-2.5 text-xs text-muted">
          {emptyLabel}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {policies.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-2 rounded-token border border-subtle bg-surface-base/40 px-2.5 py-2"
            >
              <Badge variant={p.scope === 'DOMAIN' ? 'neutral' : tone}>
                {p.scope === 'DOMAIN' ? 'domain' : 'address'}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-primary">{p.pattern}</p>
                {p.reason && <p className="truncate text-[11px] text-muted">{p.reason}</p>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={removingId === p.id}
                onClick={() => onRemove(p.id)}
                aria-label={`Remove ${p.pattern}`}
                className="shrink-0"
              >
                {removingId === p.id ? '…' : '×'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
