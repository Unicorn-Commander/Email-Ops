'use client';

/**
 * Agent Inbox — the human-in-the-loop approval queue.
 *
 * The headline surface of the Agent Email Command Center: agents stage outbound
 * email and mailbox-cleanup batches; a human reviews each one and approves
 * (EMAIL → sends, CLEANUP → executes) or rejects (never sends / executes).
 * Every decision is attributed and kept for audit. Read-only history lives
 * behind the Approved / Rejected tabs.
 */

import { useMemo, useState } from 'react';
import { Badge, Button, Card, Skeleton, SkeletonText, cn, useConfirm } from '@/components/ui';
import { useAgentInbox } from '@/components/useAgentInbox';
import { CleanupTargetsList, cleanupTargetsSentence } from '@/components/mail/CleanupTargetsList';
import { agentLabel } from '@/lib/agents';
import { deriveCleanupTargets } from '@/lib/cleanupTargets';
import type { AgentInboxItemView, AgentInboxState } from '@/lib/api';

const TABS: Array<{ value: AgentInboxState; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

export default function AgentInboxPage() {
  const { workspace, state, setState, items, pendingCount, load, error, refresh, approve, reject } =
    useAgentInbox();

  return (
    <div className="space-y-7">
      <Hero pendingCount={pendingCount} loading={load === 'loading'} onRefresh={() => void refresh()} />

      {!workspace && load === 'ready' ? (
        <NoWorkspace />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs state={state} pendingCount={pendingCount} onChange={setState} />
            {load === 'ready' && items.length > 0 && (
              <span className="font-mono text-xs text-muted">
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </span>
            )}
          </div>

          {load === 'loading' ? (
            <QueueSkeleton />
          ) : load === 'error' ? (
            <ErrorState message={error} onRetry={() => void refresh()} />
          ) : items.length === 0 ? (
            <EmptyState state={state} />
          ) : (
            <div className="space-y-3">
              {items.map((item) => (
                <ReviewCard
                  key={item.id}
                  item={item}
                  onApprove={(note) => approve(item.id, note)}
                  onReject={(note) => reject(item.id, note)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Hero({
  pendingCount,
  loading,
  onRefresh,
}: {
  pendingCount: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="relative overflow-hidden rounded-[20px] border border-subtle bg-surface-raised shadow-token">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_0%,rgb(var(--accent-2)/0.20),transparent_55%),radial-gradient(95%_130%_at_0%_100%,rgb(var(--accent)/0.18),transparent_55%),radial-gradient(80%_90%_at_50%_120%,rgb(var(--warning)/0.12),transparent_60%)]" />
      <div className="relative p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={pendingCount > 0 ? 'review' : 'success'} dot>
                {pendingCount > 0 ? `${pendingCount} awaiting you` : 'queue clear'}
              </Badge>
              <Badge variant="protected">human-in-the-loop</Badge>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
              Agents draft.{' '}
              <span className="bg-gradient-to-br from-accent via-[rgb(var(--accent-2))] to-warning bg-clip-text text-transparent">
                You approve.
              </span>
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">
              Approving an email sends it; rejecting never does. Mailbox-cleanup batches run only on
              approval. Every decision is attributed and kept for audit.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row lg:items-center">
            <Button variant="secondary" onClick={onRefresh} disabled={loading}>
              Refresh queue
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

function Tabs({
  state,
  pendingCount,
  onChange,
}: {
  state: AgentInboxState;
  pendingCount: number;
  onChange: (next: AgentInboxState) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Agent inbox filter"
      className="inline-flex rounded-token border border-subtle bg-surface-raised p-1"
    >
      {TABS.map((tab) => {
        const active = tab.value === state;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.value)}
            className={cn(
              'inline-flex min-h-[36px] items-center gap-2 rounded-token px-3 text-sm font-medium transition-colors duration-fast ease-token',
              active
                ? 'bg-surface-overlay text-primary shadow-token'
                : 'text-tertiary hover:text-primary',
            )}
          >
            {tab.label}
            {tab.value === 'pending' && pendingCount > 0 && (
              <Badge variant="review" className="font-mono">
                {pendingCount}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** EMAIL vs CLEANUP presentation (label, badge tone, the verbs in confirm copy). */
function kindMeta(kind?: string) {
  if (kind === 'CLEANUP') {
    return {
      label: 'Cleanup',
      badge: 'review' as const,
      noun: 'cleanup batch',
      approveVerb: 'Run cleanup',
      approveTitle: 'Approve this cleanup batch?',
    };
  }
  return {
    label: 'Email',
    badge: 'info' as const,
    noun: 'email',
    approveVerb: 'Approve & send',
    approveTitle: 'Send this email?',
  };
}

function ReviewCard({
  item,
  onApprove,
  onReject,
}: {
  item: AgentInboxItemView;
  onApprove: (note?: string) => Promise<{ ok: boolean; error?: string }>;
  onReject: (note?: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const confirm = useConfirm();
  const meta = useMemo(() => kindMeta(item.kind), [item.kind]);
  const targets = useMemo(
    () => (item.kind === 'CLEANUP' ? deriveCleanupTargets(item.payload) : null),
    [item.kind, item.payload],
  );
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [acting, setActing] = useState<null | 'approve' | 'reject'>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  const pending = item.state === 'pending';
  const trimmedNote = note.trim() || undefined;

  async function handleApprove() {
    const cleanupDesc = targets
      ? `${cleanupTargetsSentence(targets)} ${
          targets.verb === 'Permanently delete'
            ? 'A downloadable backup is kept first.'
            : targets.verb === 'Move to Trash'
              ? 'Trash is reversible.'
              : 'This moves them out of the inbox.'
        }`
      : `The staged batch will run (${item.summary ?? 'cleanup'}). Trash is reversible; permanent purge stays gated behind a downloadable backup.`;
    const ok = await confirm({
      title: meta.approveTitle,
      description:
        item.kind === 'CLEANUP'
          ? cleanupDesc
          : `It will be delivered to ${item.to_address ?? 'the recipient'}, drafted by ${agentLabel(item.drafted_by)}. This can't be unsent.`,
      confirmLabel: meta.approveVerb,
      cancelLabel: 'Not yet',
    });
    if (!ok) return;
    setActing('approve');
    setCardError(null);
    const res = await onApprove(trimmedNote);
    if (!res.ok) {
      setCardError(res.error ?? 'Could not approve.');
      setActing(null);
    }
    // On success the item leaves the pending slice; the card unmounts on refresh.
  }

  async function handleReject() {
    const ok = await confirm({
      title: `Reject this ${meta.noun}?`,
      description: `It won't be ${item.kind === 'CLEANUP' ? 'executed' : 'sent'}. The record is kept for audit.`,
      confirmLabel: 'Reject',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setActing('reject');
    setCardError(null);
    const res = await onReject(trimmedNote);
    if (!res.ok) {
      setCardError(res.error ?? 'Could not reject.');
      setActing(null);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={meta.badge}>{meta.label}</Badge>
            <StateBadge state={item.state} />
            <span className="inline-flex items-center gap-1.5 text-[11px] text-tertiary">
              <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
              <span className="font-mono">{agentLabel(item.drafted_by)}</span>
            </span>
            <RelativeTime iso={item.created_at} className="text-[11px] text-muted" />
          </div>

          <p className="mt-3 truncate text-sm font-medium text-primary">
            {item.subject || item.summary || '(no subject)'}
          </p>
          {item.to_address && (
            <p className="mt-1 truncate font-mono text-xs text-tertiary">to {item.to_address}</p>
          )}
          {targets ? (
            <CleanupTargetsList targets={targets} className="mt-2.5" />
          ) : (
            item.body_preview && (
              <p className="mt-2 max-h-16 overflow-hidden whitespace-pre-wrap text-xs leading-5 text-secondary">
                {item.body_preview}
              </p>
            )
          )}

          {item.state !== 'pending' && (
            <p className="mt-3 text-[11px] leading-5 text-muted">
              {item.state === 'approved' ? 'Approved' : 'Rejected'}
              {item.reviewed_by_uc_uid ? ` by ${item.reviewed_by_uc_uid}` : ''}
              {item.reviewed_at ? ' · ' : ''}
              {item.reviewed_at ? <RelativeTime iso={item.reviewed_at} /> : null}
              {item.review_note ? ` · “${item.review_note}”` : ''}
            </p>
          )}

          {cardError && <p className="mt-3 text-xs text-danger">{cardError}</p>}
        </div>

        {pending && (
          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:w-[160px]">
            <Button size="sm" disabled={acting !== null} onClick={() => void handleApprove()}>
              {acting === 'approve' ? 'Approving…' : meta.approveVerb}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={acting !== null}
              onClick={() => void handleReject()}
            >
              {acting === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
            <button
              type="button"
              onClick={() => setNoteOpen((open) => !open)}
              className="text-[11px] text-tertiary transition hover:text-primary"
            >
              {noteOpen ? 'Hide note' : 'Add a note'}
            </button>
          </div>
        )}
      </div>

      {pending && noteOpen && (
        <div className="border-t border-subtle bg-surface-base/40 p-4">
          <label className="block text-[11px] font-medium text-tertiary" htmlFor={`note-${item.id}`}>
            Review note (optional — kept on the audit record)
          </label>
          <textarea
            id={`note-${item.id}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Why you approved or rejected…"
            className="mt-1.5 w-full resize-y rounded-token border border-subtle bg-surface-raised px-3 py-2 text-sm text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </div>
      )}
    </Card>
  );
}

function StateBadge({ state }: { state: AgentInboxState }) {
  if (state === 'approved') return <Badge variant="success">approved</Badge>;
  if (state === 'rejected') return <Badge variant="danger">rejected</Badge>;
  return <Badge variant="warning">pending</Badge>;
}

function RelativeTime({ iso, className }: { iso: string | null; className?: string }) {
  const label = useMemo(() => formatWhen(iso), [iso]);
  if (!label) return null;
  return <span className={className}>{label}</span>;
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function QueueRowSkeleton() {
  return (
    <Card padded>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-3">
          <Skeleton w="30%" h={14} />
          <Skeleton w="70%" h={16} />
          <SkeletonText lines={2} />
        </div>
        <div className="w-[160px] space-y-2">
          <Skeleton h={32} />
          <Skeleton h={32} />
        </div>
      </div>
    </Card>
  );
}

function QueueSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <QueueRowSkeleton key={i} />
      ))}
    </div>
  );
}

function EmptyState({ state }: { state: AgentInboxState }) {
  if (state === 'pending') {
    return (
      <Card padded className="overflow-hidden border-success/30 bg-success-subtle ring-1 ring-success/20">
        <div className="flex items-start gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-success/30 to-success/5 text-success ring-1 ring-success/30">
            <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <p className="text-base font-semibold text-primary">Nothing awaiting you.</p>
            <p className="mt-1 text-sm text-tertiary">
              When an agent drafts an email or stages a cleanup, it lands here for your approval
              before anything is sent.
            </p>
          </div>
        </div>
      </Card>
    );
  }
  return (
    <Card padded>
      <p className="text-sm text-tertiary">
        No {state} items yet. Decisions you make on the Pending tab show up here.
      </p>
    </Card>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <Card padded className="border-danger/30 ring-1 ring-danger/15">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Could not load the queue.</p>
          <p className="mt-1 text-xs text-danger">{message ?? 'Unknown error.'}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}

function NoWorkspace() {
  return (
    <Card padded>
      <p className="text-sm font-medium text-primary">No workspace yet.</p>
      <p className="mt-1 text-sm text-tertiary">
        Your account isn’t a member of an Email-Ops workspace, so there’s no agent inbox to show.
      </p>
    </Card>
  );
}
