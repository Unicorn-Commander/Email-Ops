'use client';

/**
 * Management surfaces for the two scheduling planes:
 *   • SnoozedDialog   — active snoozed threads (subject + when it wakes), unsnooze inline.
 *   • ScheduledDialog — pending send-later messages (recipient + subject + when), cancel inline.
 *
 * Both are self-contained: they read straight from the mail API scoped to ONE
 * sovereign mailbox, render a loading / empty / error state, and apply each row
 * action optimistically with a truthful rollback (a `false` result — dormant /
 * external / already-gone — restores the row and surfaces why). The page only
 * opens them for a sovereign (stalwart) mailbox; an external/unified mailbox
 * simply comes back empty (degrade-clean).
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog } from '@/components/ui';
import { ApiError } from '@/lib/api';
import {
  cancelScheduledSend,
  listScheduledSends,
  listSnoozed,
  unsnoozeThread,
  type MailboxPick,
  type ScheduledSendView,
  type SnoozedThreadView,
} from '@/lib/mailApi';
import { formatScheduleAbsolute } from '@/lib/scheduleTime';

type Load = 'loading' | 'ready' | 'error';

interface ManageProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string | null;
  mailbox: MailboxPick | null;
  /** Called after a change that affects the inbox (an unsnooze restores a thread). */
  onChanged?: () => void;
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className} aria-hidden>
      <path d="M22 2 11 13" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M22 2 15 22l-4-9-9-4Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A friendly, non-alarming empty panel (icon + one line). */
function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-overlay text-tertiary">
        {icon}
      </div>
      <p className="text-sm font-medium text-secondary">{title}</p>
      <p className="max-w-[16rem] text-xs text-tertiary">{hint}</p>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-1 py-2.5">
      <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-overlay" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-2/3 animate-pulse rounded bg-surface-overlay" />
        <div className="h-2.5 w-1/3 animate-pulse rounded bg-surface-overlay" />
      </div>
    </div>
  );
}

/** Shared dialog scaffold so both planes render identically. */
function ManageShell({
  open,
  onClose,
  title,
  description,
  count,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  count: number | null;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        <span className="flex items-center gap-2">
          {title}
          {count != null && count > 0 && (
            <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] font-medium text-secondary tabular-nums">
              {count}
            </span>
          )}
        </span>
      }
      description={description}
      className="max-w-lg"
    >
      <div className="max-h-[min(60vh,28rem)] overflow-y-auto">{children}</div>
    </Dialog>
  );
}

export function SnoozedDialog({ open, onClose, workspaceId, mailbox, onChanged }: ManageProps) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>('loading');
  const [items, setItems] = useState<SnoozedThreadView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  useEffect(() => {
    // Reset on close so a reopen (possibly for a DIFFERENT mailbox) never paints
    // the previous open's rows/count for a frame before the fetch resolves.
    if (!open) {
      setLoad('loading');
      setItems([]);
      setError(null);
      return;
    }
    if (!workspaceId || !mailbox?.id) return;
    let alive = true;
    setLoad('loading');
    setError(null);
    void (async () => {
      try {
        const res = await listSnoozed(workspaceId, mailbox.id);
        if (!alive) return;
        setItems(res.snoozed);
        setLoad('ready');
      } catch (err) {
        if (!alive) return;
        if (guard401(err)) return;
        setError('Could not load snoozed conversations.');
        setLoad('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, workspaceId, mailbox?.id, guard401]);

  const unsnooze = useCallback(
    async (row: SnoozedThreadView) => {
      if (!workspaceId || !mailbox?.id || busyId) return;
      setBusyId(row.id);
      // Optimistic: drop the row now; restore it if nothing actually happened.
      const before = items;
      setItems((prev) => prev.filter((r) => r.id !== row.id));
      try {
        const res = await unsnoozeThread(workspaceId, mailbox.id, row.thread_id);
        if (!res.unsnoozed) {
          setItems(before);
          setError('That conversation could not be brought back.');
          return;
        }
        setError(null);
        onChanged?.(); // it returned to the Inbox — refresh the list behind us
      } catch (err) {
        setItems(before);
        if (guard401(err)) return;
        setError('Could not bring that conversation back.');
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, mailbox?.id, busyId, items, onChanged, guard401],
  );

  return (
    <ManageShell
      open={open}
      onClose={onClose}
      title="Snoozed"
      description="Conversations hidden until a chosen time. They return to your Inbox automatically — bring one back early below."
      count={load === 'ready' ? items.length : null}
    >
      {load === 'loading' ? (
        <div className="divide-y divide-subtle">
          <RowSkeleton />
          <RowSkeleton />
        </div>
      ) : load === 'error' ? (
        <EmptyState icon={<ClockIcon className="h-5 w-5" />} title="Couldn’t load snoozed mail" hint={error ?? 'Try again in a moment.'} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ClockIcon className="h-5 w-5" />}
          title="Nothing snoozed"
          hint="Snooze a conversation from the reader to tuck it away until later — it’ll reappear here until it wakes."
        />
      ) : (
        <ul className="divide-y divide-subtle">
          {items.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-tertiary">
                <ClockIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-primary">
                  {row.subject?.trim() || '(no subject)'}
                </p>
                <p className="text-[11px] text-tertiary">
                  Wakes {formatScheduleAbsolute(row.snooze_until) ?? 'soon'}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={busyId === row.id}
                onClick={() => void unsnooze(row)}
              >
                {busyId === row.id ? 'Bringing back…' : 'Unsnooze'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {load === 'ready' && error && <p className="px-1 pt-2 text-xs text-danger">{error}</p>}
    </ManageShell>
  );
}

export function ScheduledDialog({ open, onClose, workspaceId, mailbox, onChanged }: ManageProps) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>('loading');
  const [items, setItems] = useState<ScheduledSendView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  useEffect(() => {
    // Reset on close so a reopen (possibly for a DIFFERENT mailbox) never paints
    // the previous open's rows/count for a frame before the fetch resolves.
    if (!open) {
      setLoad('loading');
      setItems([]);
      setError(null);
      return;
    }
    if (!workspaceId || !mailbox?.id) return;
    let alive = true;
    setLoad('loading');
    setError(null);
    void (async () => {
      try {
        const res = await listScheduledSends(workspaceId, mailbox.id);
        if (!alive) return;
        setItems(res.scheduled_sends);
        setLoad('ready');
      } catch (err) {
        if (!alive) return;
        if (guard401(err)) return;
        setError('Could not load scheduled messages.');
        setLoad('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, workspaceId, mailbox?.id, guard401]);

  const cancel = useCallback(
    async (row: ScheduledSendView) => {
      if (!workspaceId || !mailbox?.id || busyId) return;
      setBusyId(row.id);
      const before = items;
      setItems((prev) => prev.filter((r) => r.id !== row.id));
      try {
        const res = await cancelScheduledSend(workspaceId, mailbox.id, row.id);
        if (!res.cancelled) {
          setItems(before);
          // Most likely it already left (fired) or was cancelled elsewhere.
          setError('That message could not be cancelled — it may have already sent.');
          return;
        }
        setError(null);
        onChanged?.();
      } catch (err) {
        setItems(before);
        if (guard401(err)) return;
        setError('Could not cancel that message.');
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, mailbox?.id, busyId, items, onChanged, guard401],
  );

  return (
    <ManageShell
      open={open}
      onClose={onClose}
      title="Scheduled"
      description="Messages queued to send later. Cancel one below before it leaves — it will not send once cancelled."
      count={load === 'ready' ? items.length : null}
    >
      {load === 'loading' ? (
        <div className="divide-y divide-subtle">
          <RowSkeleton />
          <RowSkeleton />
        </div>
      ) : load === 'error' ? (
        <EmptyState icon={<SendClockIcon className="h-5 w-5" />} title="Couldn’t load scheduled mail" hint={error ?? 'Try again in a moment.'} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<SendClockIcon className="h-5 w-5" />}
          title="Nothing scheduled"
          hint="Use “Send later” in the composer to queue a message for a better time — it’ll wait here until it sends."
        />
      ) : (
        <ul className="divide-y divide-subtle">
          {items.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-tertiary">
                <SendClockIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-primary">
                  {row.payload.subject?.trim() || '(no subject)'}
                </p>
                <p className="truncate text-[11px] text-tertiary">
                  To {row.payload.toAddress || 'unknown'} · sends {formatScheduleAbsolute(row.send_at) ?? 'soon'}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={busyId === row.id}
                onClick={() => void cancel(row)}
              >
                {busyId === row.id ? 'Cancelling…' : 'Cancel'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {load === 'ready' && error && <p className="px-1 pt-2 text-xs text-danger">{error}</p>}
    </ManageShell>
  );
}
