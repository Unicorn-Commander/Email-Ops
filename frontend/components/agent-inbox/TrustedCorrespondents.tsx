'use client';

/**
 * Trusted correspondents — the allowlist behind agent auto-replies (Wave 7).
 *
 * An address on this list may receive policy-auto-sent agent mail without a
 * per-message human approval. Trust is earned two ways: a human checks "trust
 * this correspondent" while approving a first-contact draft (APPROVAL), or adds
 * the address by hand here (MANUAL). Removing an address puts future agent
 * replies to it back through the approval queue.
 *
 * This file carries both the data hook (`useTrustedCorrespondents` — shared by
 * the manager dialog, the auto-sent rows' revoke actions, and the review panel)
 * and the manager dialog itself. The endpoint ships with the Wave-7 backend;
 * 404/501 → `load: 'absent'` and every surface degrades to an honest notice.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Dialog, Input, useConfirm } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { isValidEmail } from '@/components/mail/RecipientChips';
import {
  addTrustedCorrespondent,
  listTrustedCorrespondents,
  removeTrustedCorrespondent,
  ApiError,
  type TrustedCorrespondentView,
} from '@/lib/api';

export type TrustedLoad = 'loading' | 'ready' | 'error' | 'absent';

export interface TrustedOutcome {
  ok: boolean;
  error?: string;
}

export interface UseTrustedCorrespondents {
  items: TrustedCorrespondentView[];
  load: TrustedLoad;
  error: string | null;
  refresh: () => Promise<void>;
  /** Trust an address by hand. Refreshes on success. */
  add: (address: string, note?: string) => Promise<TrustedOutcome>;
  /** Revoke trust by row id. Refreshes on success. */
  remove: (id: string) => Promise<TrustedOutcome>;
  /** Revoke trust by address (resolves the row id from the loaded list). */
  removeByAddress: (address: string) => Promise<TrustedOutcome>;
  /** The trusted row for an address, when the list has loaded (else null). */
  find: (address: string) => TrustedCorrespondentView | null;
}

function endpointMissing(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Bare address of a possibly-"Name <addr>" formatted recipient, lowercased. */
export function bareAddress(raw: string): string {
  const angled = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (angled ? angled[1] : raw).trim().toLowerCase();
}

export function useTrustedCorrespondents(workspaceId: string | null): UseTrustedCorrespondents {
  const [items, setItems] = useState<TrustedCorrespondentView[]>([]);
  const [load, setLoad] = useState<TrustedLoad>('loading');
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (ws: string, silent = false) => {
    if (!silent) setLoad('loading');
    try {
      const res = await listTrustedCorrespondents(ws);
      setItems(res.items);
      setError(null);
      setLoad('ready');
    } catch (err) {
      if (endpointMissing(err)) {
        setItems([]);
        setError(null);
        setLoad('absent');
        return;
      }
      setError(messageOf(err, 'Could not load trusted correspondents.'));
      setLoad('error');
    }
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      setLoad('loading');
      return;
    }
    void fetchOnce(workspaceId);
  }, [workspaceId, fetchOnce]);

  const refresh = useCallback(async () => {
    if (workspaceId) await fetchOnce(workspaceId);
  }, [workspaceId, fetchOnce]);

  const add = useCallback(
    async (address: string, note?: string): Promise<TrustedOutcome> => {
      if (!workspaceId) return { ok: false, error: 'No active workspace.' };
      try {
        await addTrustedCorrespondent(workspaceId, address, note);
        await fetchOnce(workspaceId, true);
        return { ok: true };
      } catch (err) {
        if (endpointMissing(err)) {
          return { ok: false, error: 'Trusted correspondents are not available on this server yet.' };
        }
        return { ok: false, error: messageOf(err, 'Could not trust that address.') };
      }
    },
    [workspaceId, fetchOnce],
  );

  const remove = useCallback(
    async (id: string): Promise<TrustedOutcome> => {
      if (!workspaceId) return { ok: false, error: 'No active workspace.' };
      try {
        await removeTrustedCorrespondent(workspaceId, id);
        await fetchOnce(workspaceId, true);
        return { ok: true };
      } catch (err) {
        if (endpointMissing(err)) {
          return { ok: false, error: 'Trusted correspondents are not available on this server yet.' };
        }
        return { ok: false, error: messageOf(err, 'Could not revoke trust.') };
      }
    },
    [workspaceId, fetchOnce],
  );

  const find = useCallback(
    (address: string): TrustedCorrespondentView | null => {
      const needle = bareAddress(address);
      return items.find((it) => bareAddress(it.address) === needle) ?? null;
    },
    [items],
  );

  const removeByAddress = useCallback(
    async (address: string): Promise<TrustedOutcome> => {
      const row = find(address);
      if (!row) {
        return {
          ok: false,
          error:
            load === 'absent'
              ? 'Trusted correspondents are not available on this server yet.'
              : `${bareAddress(address)} is not on the trusted list.`,
        };
      }
      return remove(row.id);
    },
    [find, remove, load],
  );

  return useMemo(
    () => ({ items, load, error, refresh, add, remove, removeByAddress, find }),
    [items, load, error, refresh, add, remove, removeByAddress, find],
  );
}

// ── Manager dialog ───────────────────────────────────────────────────────────

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TrustedCorrespondentsDialog({
  open,
  onOpenChange,
  trusted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trusted: UseTrustedCorrespondents;
}) {
  const confirm = useConfirm();
  const [addr, setAddr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // 'add' | row id
  const [rowError, setRowError] = useState<string | null>(null);

  // Re-sync the list every time the dialog opens (approvals may have added rows).
  useEffect(() => {
    if (open) {
      setRowError(null);
      void trusted.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A bare domain (no '@', or a leading '@') trusts everyone at it; anything with
  // a real localpart is an address. The server is the validator — this only
  // shapes the button label / hint and the enable gate.
  const trimmedAddr = addr.trim().toLowerCase();
  const addWillBeDomain =
    trimmedAddr !== '' && !/^[^\s@]+@[^\s@]+$/.test(trimmedAddr);
  const isValidDomain = /^[^\s@]+\.[^\s@]+$/.test(trimmedAddr.replace(/^@/, ''));
  const addIsValid = addWillBeDomain ? isValidDomain : isValidEmail(addr);
  const canAdd = addIsValid && busy === null && trusted.load !== 'absent';

  async function handleAdd() {
    if (!canAdd) return;
    setBusy('add');
    setRowError(null);
    const res = await trusted.add(addr.trim(), note.trim() || undefined);
    setBusy(null);
    if (!res.ok) {
      setRowError(res.error ?? 'Could not trust that address.');
      return;
    }
    setAddr('');
    setNote('');
  }

  async function handleRemove(row: { id: string; address: string }) {
    const ok = await confirm({
      title: `Revoke trust for ${row.address}?`,
      description:
        'Future agent replies to this correspondent go back through your approval queue. Nothing already sent is affected.',
      confirmLabel: 'Revoke trust',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setBusy(row.id);
    setRowError(null);
    const res = await trusted.remove(row.id);
    setBusy(null);
    if (!res.ok) setRowError(res.error ?? 'Could not revoke trust.');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Trusted correspondents"
      description="Agents may auto-reply to these addresses under policy — no per-message approval. Revoking sends future replies back through your queue."
      className="max-w-lg"
    >
      <div className="space-y-4">
        {/* Manual add */}
        <div className="rounded-token border border-subtle bg-surface-base/50 p-3">
          <label className="block text-[11px] font-medium text-tertiary" htmlFor="trust-add-address">
            Trust an address or a whole domain
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <Input
              id="trust-add-address"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder="jane@acme.com  or  acme.com"
              autoComplete="off"
              spellCheck={false}
              disabled={busy !== null || trusted.load === 'absent'}
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd();
              }}
            />
            <Button size="sm" disabled={!canAdd} onClick={() => void handleAdd()}>
              {busy === 'add'
                ? 'Trusting…'
                : addWillBeDomain
                  ? 'Trust domain'
                  : 'Trust'}
            </Button>
          </div>
          {addr.trim() !== '' && (
            <p className="mt-1 text-[11px] text-tertiary">
              {addWillBeDomain
                ? `Trusts everyone at ${addr.trim().toLowerCase().replace(/^@/, '')}.`
                : 'Trusts this one address.'}
            </p>
          )}
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional — why this address is trusted)"
            disabled={busy !== null || trusted.load === 'absent'}
            className="mt-2"
            maxLength={300}
          />
        </div>

        {/* List */}
        {trusted.load === 'loading' ? (
          <p className="py-2 text-sm text-tertiary">Loading trusted correspondents…</p>
        ) : trusted.load === 'absent' ? (
          <p className="py-2 text-sm text-tertiary">
            This server doesn’t expose trusted correspondents yet — the Wave-7 backend adds it.
            Nothing auto-sends until then.
          </p>
        ) : trusted.load === 'error' ? (
          <div className="flex items-center justify-between gap-3 py-2">
            <p className="text-sm text-danger">{trusted.error ?? 'Could not load the list.'}</p>
            <Button variant="secondary" size="sm" onClick={() => void trusted.refresh()}>
              Retry
            </Button>
          </div>
        ) : trusted.items.length === 0 ? (
          <div className="py-2">
            <p className="text-sm text-tertiary">
              No trusted correspondents yet. Approving a first-contact draft with the trust box
              checked adds its recipient here.
            </p>
            <Link
              href="/help#trusted-senders"
              className="mt-1.5 inline-block text-sm font-medium text-accent hover:underline"
            >
              How trust works →
            </Link>
          </div>
        ) : (
          <ul className="max-h-[42dvh] space-y-1.5 overflow-y-auto pr-0.5">
            {trusted.items.map((row) => (
              <li
                key={row.id}
                className="flex items-start justify-between gap-3 rounded-token border border-subtle bg-surface-raised px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-primary">
                    {row.scope === 'DOMAIN' ? `@${row.address}` : row.address}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted">
                    {row.scope === 'DOMAIN' && (
                      <Tooltip content="Everyone at this domain is trusted for routine agent auto-replies.">
                        <Badge variant="warning">whole domain</Badge>
                      </Tooltip>
                    )}
                    <Badge variant={row.source === 'MANUAL' ? 'info' : 'success'}>
                      {row.source === 'MANUAL' ? 'added by hand' : 'via approval'}
                    </Badge>
                    {row.approval_count > 0 && (
                      <span>
                        {row.approval_count} approval{row.approval_count === 1 ? '' : 's'}
                      </span>
                    )}
                    {formatDay(row.last_approved_at) && (
                      <span>last {formatDay(row.last_approved_at)}</span>
                    )}
                  </p>
                  {row.note && (
                    <p className="mt-0.5 truncate text-[11px] text-tertiary" title={row.note}>
                      “{row.note}”
                    </p>
                  )}
                </div>
                <Tooltip content="Revoke trust — future agent replies to this address go back through your approval queue">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void handleRemove(row)}
                  >
                    {busy === row.id ? 'Revoking…' : 'Revoke'}
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}

        {rowError && <p className="text-xs text-danger">{rowError}</p>}
      </div>
    </Dialog>
  );
}
