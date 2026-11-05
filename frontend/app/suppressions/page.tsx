'use client';

/**
 * Suppressions — addresses Email-Ops will never mail from this workspace.
 *
 * List is `GET /workspaces/:id/suppressions` (newest 1,000). The reason select
 * refetches with `?reason=` (the route's enum filter). The email box is a
 * substring over that payload: the route's `email` query is an exact address
 * and rejects a partial string. Add posts `{ email, note? }` (the server
 * records MANUAL and upserts). Remove confirms, then DELETEs; a 403 (a
 * personal access token, or a role below MEMBER) is shown as the API message.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Input, Select, Skeleton, cn, useConfirm, type BadgeVariant } from '@/components/ui';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { ApiError } from '@/lib/api';
import {
  SUPPRESSION_LIST_CAP,
  SUPPRESSION_REASONS,
  createSuppression,
  isSuppressionReason,
  listSuppressions,
  removeSuppression,
  type SuppressionReason,
  type SuppressionView,
} from '@/lib/suppressionsApi';

type Load = 'loading' | 'ready' | 'error';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTE_MAX = 2000;

const REASON_META: Record<SuppressionReason, { label: string; tone: BadgeVariant }> = {
  UNSUBSCRIBED: { label: 'Unsubscribed', tone: 'info' },
  BOUNCED: { label: 'Bounced', tone: 'warning' },
  COMPLAINT: { label: 'Complaint', tone: 'danger' },
  MANUAL: { label: 'Manual', tone: 'neutral' },
};

const EMPTY_COPY =
  'Addresses Email-Ops will never mail from this workspace: one-click unsubscribes, hard bounces, complaints, manual adds.';

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function reasonLabel(reason: string): string {
  return isSuppressionReason(reason) ? REASON_META[reason].label : reason || 'Unknown';
}

function reasonTone(reason: string): BadgeVariant {
  return isSuppressionReason(reason) ? REASON_META[reason].tone : 'neutral';
}

function formatWhen(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

interface DraftErrors {
  email?: string;
  note?: string;
}

function validateDraft(email: string, note: string): DraftErrors {
  const value = email.trim();
  const errors: DraftErrors = {};
  if (!value) errors.email = 'Enter an email address.';
  else if (!EMAIL_RE.test(value)) errors.email = 'Enter a valid email address.';
  if (note.length > NOTE_MAX) errors.note = `Keep the note to ${NOTE_MAX.toLocaleString()} characters.`;
  return errors;
}

export default function SuppressionsPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;

  const [items, setItems] = useState<SuppressionView[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [load, setLoad] = useState<Load>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<'' | SuppressionReason>('');
  const [emailQuery, setEmailQuery] = useState('');

  const [draftEmail, setDraftEmail] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [draftTried, setDraftTried] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const requestSeq = useRef(0);
  const seenWorkspace = useRef<string | null>(null);

  const guard401 = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/auth/login');
        return true;
      }
      return false;
    },
    [router],
  );

  const fetchFor = useCallback(
    async (id: string, reasonFilter: '' | SuppressionReason, silent = false) => {
      const seq = ++requestSeq.current;
      if (!silent) setLoad('loading');
      else setRefreshing(true);
      try {
        const response = await listSuppressions(
          id,
          reasonFilter ? { reason: reasonFilter } : undefined,
        );
        if (seq !== requestSeq.current) return;
        setItems(response.items);
        setLoadedCount(response.count);
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (seq !== requestSeq.current) return;
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not load suppressions.'));
        setLoad('error');
      } finally {
        if (seq === requestSeq.current) setRefreshing(false);
      }
    },
    [guard401],
  );

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      setLoadedCount(0);
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    const silent = seenWorkspace.current === workspaceId;
    seenWorkspace.current = workspaceId;
    void fetchFor(workspaceId, reason, silent);
  }, [fetchFor, reason, workspaceId, workspaceLoad]);

  const visible = useMemo(() => {
    const query = emailQuery.trim().toLowerCase();
    if (!query) return items;
    return items.filter((row) => row.email.toLowerCase().includes(query));
  }, [emailQuery, items]);

  const draftErrors = draftTried ? validateDraft(draftEmail, draftNote) : {};

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || adding) return;
    setDraftTried(true);
    setFormError(null);
    setSavedNotice(null);
    const errors = validateDraft(draftEmail, draftNote);
    if (errors.email || errors.note) return;

    const email = draftEmail.trim();
    const note = draftNote.trim();
    const existing = items.find((row) => row.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      const ok = await confirm({
        title: `Replace the suppression for ${existing.email}?`,
        description: `It is already listed as ${reasonLabel(existing.reason)}. Saving records it as Manual and replaces the note.`,
        confirmLabel: 'Save as Manual',
        cancelLabel: 'Keep current',
        destructive: existing.reason !== 'MANUAL',
      });
      if (!ok) return;
    }

    setAdding(true);
    try {
      const saved = await createSuppression(workspaceId, {
        email,
        ...(note ? { note } : {}),
      });
      setDraftEmail('');
      setDraftNote('');
      setDraftTried(false);
      setSavedNotice(`Saved ${saved.email} as Manual.`);
      // A non-Manual slice would hide the row we just wrote. Switch to Manual
      // (the effect reloads) or refresh in place when that slice is already showing.
      if (reason !== '' && reason !== 'MANUAL') setReason('MANUAL');
      else await fetchFor(workspaceId, reason, true);
    } catch (err) {
      if (!guard401(err)) setFormError(messageOf(err, 'Could not add that address.'));
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(row: SuppressionView) {
    if (!workspaceId || removingId) return;
    const ok = await confirm({
      title: `Remove ${row.email}?`,
      description:
        'Email-Ops will be able to mail this address from this workspace again. One-click unsubscribes, bounces, and complaints can suppress it again later.',
      confirmLabel: 'Remove',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setRemovingId(row.id);
    setRemoveError(null);
    try {
      await removeSuppression(workspaceId, row.id);
      await fetchFor(workspaceId, reason, true);
    } catch (err) {
      if (!guard401(err)) setRemoveError(messageOf(err, 'Could not remove that address.'));
    } finally {
      setRemovingId(null);
    }
  }

  const countLabel = emailQuery.trim()
    ? `${visible.length} of ${loadedCount}`
    : `${loadedCount}`;
  const badgeText =
    !workspaceId && workspaceLoad !== 'loading'
      ? 'No workspace'
      : workspaceLoad === 'loading' || (workspaceId !== null && load === 'loading')
        ? 'Loading'
        : `${countLabel} suppressed`;

  return (
    <div className="space-y-7">
      <header className="relative overflow-hidden rounded-[20px] border border-subtle bg-surface-raised shadow-token">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_0%,rgb(var(--accent-2)/0.18),transparent_55%),radial-gradient(95%_130%_at_0%_100%,rgb(var(--accent)/0.14),transparent_55%)]" />
        <div className="relative flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={loadedCount > 0 ? 'warning' : 'neutral'} dot>
                {badgeText}
              </Badge>
              <Badge variant="protected">never mail</Badge>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
              Suppressions
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">{EMPTY_COPY}</p>
          </div>
          <Button
            variant="secondary"
            onClick={() => workspaceId && void fetchFor(workspaceId, reason, load === 'ready')}
            disabled={!workspaceId || load === 'loading' || refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {!workspaceId && workspaceLoad !== 'loading' ? (
        <Card padded>
          <p className="font-medium text-primary">No active workspace.</p>
          <p className="mt-1 text-sm text-tertiary">
            Join or select a workspace to see the addresses it will not mail.
          </p>
        </Card>
      ) : (
        <>
          <Card padded>
            <h2 className="text-sm font-semibold text-primary">Add address</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-tertiary">
              Records a Manual suppression. If the address is already listed, saving replaces its
              reason and note.
            </p>
            <form
              className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto] sm:items-start"
              noValidate
              onSubmit={onAdd}
            >
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-tertiary">Email</span>
                <Input
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  value={draftEmail}
                  invalid={Boolean(draftErrors.email)}
                  aria-invalid={draftErrors.email ? true : undefined}
                  aria-describedby={draftErrors.email ? 'suppression-email-error' : undefined}
                  placeholder="person@example.com"
                  onChange={(event) => {
                    setDraftEmail(event.target.value);
                    setSavedNotice(null);
                  }}
                  disabled={!workspaceId || adding}
                />
                {draftErrors.email && (
                  <span id="suppression-email-error" className="mt-1 block text-[11px] leading-5 text-danger">
                    {draftErrors.email}
                  </span>
                )}
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-tertiary">
                  Note <span className="font-normal text-muted">(optional)</span>
                </span>
                <textarea
                  value={draftNote}
                  aria-invalid={draftErrors.note ? true : undefined}
                  aria-describedby={draftErrors.note ? 'suppression-note-error' : undefined}
                  maxLength={NOTE_MAX}
                  rows={2}
                  placeholder="Why this address is suppressed"
                  onChange={(event) => setDraftNote(event.target.value)}
                  disabled={!workspaceId || adding}
                  className={cn(
                    'block w-full resize-y rounded-token bg-surface-base text-primary placeholder:text-muted',
                    'min-h-[44px] px-3 py-2 text-base sm:min-h-[36px] sm:text-sm',
                    'border transition-colors duration-fast ease-token',
                    'focus:outline-none focus:ring-2',
                    draftErrors.note
                      ? 'border-danger/50 focus:border-danger focus:ring-danger/40'
                      : 'border-border focus:border-accent focus:ring-accent/40',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                />
                {draftErrors.note && (
                  <span id="suppression-note-error" className="mt-1 block text-[11px] leading-5 text-danger">
                    {draftErrors.note}
                  </span>
                )}
              </label>
              <div className="sm:pt-[22px]">
                <Button type="submit" disabled={!workspaceId || adding || load === 'loading'}>
                  {adding ? 'Adding…' : 'Add address'}
                </Button>
              </div>
            </form>
            {formError && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {formError}
              </p>
            )}
            {savedNotice && !formError && (
              <p role="status" className="mt-3 text-sm text-success">
                {savedNotice}
              </p>
            )}
          </Card>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block min-w-0 flex-1">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Filter by email</span>
              <Input
                type="search"
                value={emailQuery}
                autoComplete="off"
                spellCheck={false}
                placeholder="Substring of the address"
                aria-label="Filter suppressions by email"
                onChange={(event) => setEmailQuery(event.target.value)}
                disabled={!workspaceId || load === 'loading'}
              />
            </label>
            <label className="block w-full sm:w-56">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Reason</span>
              <Select
                aria-label="Filter suppressions by reason"
                value={reason}
                disabled={!workspaceId || load === 'loading'}
                onChange={(event) => {
                  const next = event.target.value;
                  setReason(isSuppressionReason(next) ? next : '');
                }}
              >
                <option value="">All reasons</option>
                {SUPPRESSION_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {REASON_META[value].label}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          {removeError && (
            <p role="alert" className="rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
              {removeError}
            </p>
          )}

          {load === 'loading' ? (
            <ListSkeleton />
          ) : load === 'error' ? (
            <Card padded>
              <p className="font-medium text-danger">Could not load suppressions.</p>
              <p className="mt-1 text-sm text-tertiary">{error}</p>
              <Button
                className="mt-4"
                variant="secondary"
                onClick={() => workspaceId && void fetchFor(workspaceId, reason)}
              >
                Try again
              </Button>
            </Card>
          ) : items.length === 0 ? (
            <Card padded>
              <p className="text-base font-semibold text-primary">
                {reason ? `No ${reasonLabel(reason).toLowerCase()} addresses.` : 'Nothing is suppressed.'}
              </p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-tertiary">{EMPTY_COPY}</p>
            </Card>
          ) : visible.length === 0 ? (
            <Card padded>
              <p className="font-medium text-primary">No addresses match this email filter.</p>
              <p className="mt-1 text-sm text-tertiary">
                {loadedCount} loaded
                {reason ? ` for ${reasonLabel(reason).toLowerCase()}` : ''}. The filter checks the address text only.
              </p>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-token-lg border border-subtle bg-surface-raised shadow-token">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-subtle bg-surface-overlay/60 text-[12px] uppercase tracking-[0.06em] text-tertiary">
                    <th className="px-3 py-2.5 font-semibold">Email</th>
                    <th className="px-3 py-2.5 font-semibold">Reason</th>
                    <th className="px-3 py-2.5 font-semibold">Source</th>
                    <th className="px-3 py-2.5 font-semibold">Note</th>
                    <th className="px-3 py-2.5 font-semibold">Added</th>
                    <th className="px-3 py-2.5 font-semibold">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="text-secondary">
                  {visible.map((row) => (
                    <tr key={row.id} className="border-b border-subtle last:border-b-0">
                      <td className="px-3 py-2.5 font-medium text-primary">{row.email}</td>
                      <td className="px-3 py-2.5">
                        <Badge variant={reasonTone(row.reason)}>{reasonLabel(row.reason)}</Badge>
                      </td>
                      <td className="max-w-[14rem] px-3 py-2.5">
                        <span className="block truncate font-mono text-[12px] text-tertiary" title={row.source}>
                          {row.source || '—'}
                        </span>
                      </td>
                      <td className="max-w-[18rem] px-3 py-2.5">
                        <span className="block truncate text-tertiary" title={row.note ?? undefined}>
                          {row.note?.trim() ? row.note : '—'}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-tertiary">{formatWhen(row.createdAt)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={removingId !== null}
                          onClick={() => void onRemove(row)}
                        >
                          {removingId === row.id ? 'Removing…' : 'Remove'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {load === 'ready' && items.length >= SUPPRESSION_LIST_CAP && (
            <p className="text-[12px] leading-5 text-muted">
              Showing the newest {SUPPRESSION_LIST_CAP.toLocaleString()}
              {reason ? ` ${reasonLabel(reason).toLowerCase()}` : ''} addresses. The list has no further pages.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <Card padded>
      <div className="space-y-3">
        <Skeleton h={14} w="40%" />
        <Skeleton h={14} w="100%" />
        <Skeleton h={14} w="92%" />
        <Skeleton h={14} w="80%" />
      </div>
    </Card>
  );
}
