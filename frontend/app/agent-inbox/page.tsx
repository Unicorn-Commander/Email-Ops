'use client';

/**
 * Agent Inbox — the human-in-the-loop approval queue (Wave 7: full-fidelity).
 *
 * The headline surface of the Agent Email Command Center: agents stage outbound
 * email and mailbox-cleanup batches; a human reviews each one and approves
 * (EMAIL → sends, CLEANUP → executes) or rejects (never sends / executes).
 * Every decision is attributed and kept for audit.
 *
 * Three lanes:
 *   - Pending    — the queue. Selecting an item opens the full-fidelity
 *     ReviewPanel: the rendered email exactly as the recipient will see it
 *     (or a cleanup batch's complete affected-message list) before deciding.
 *   - Auto-sent  — the after-the-fact audit of policy-auto-sent agent mail
 *     (no human approved each message), with per-recipient trust revocation.
 *   - History    — approved + rejected decisions, merged newest-first.
 *
 * Trusted correspondents (the allowlist behind auto-replies) are managed from
 * the header dialog. House rule: nothing shows as done until the API confirms.
 */

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { Badge, Button, Card, Skeleton, SkeletonText, cn, useConfirm } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { useAgentInbox } from '@/components/useAgentInbox';
import { useAgents } from '@/components/useAgents';
import { useAutoSent } from '@/components/agent-inbox/useAutoSent';
import {
  TrustedCorrespondentsDialog,
  useTrustedCorrespondents,
} from '@/components/agent-inbox/TrustedCorrespondents';
import { ReviewPanel, type ReviewSubject } from '@/components/agent-inbox/ReviewPanel';
import { CleanupTargetsList, cleanupTargetsSentence } from '@/components/mail/CleanupTargetsList';
import { RobotIcon } from '@/components/mail/icons';
import { agentLabel } from '@/lib/agents';
import { cleanupReason, deriveCleanupTargets } from '@/lib/cleanupTargets';
import { holdPolicyOf, type AgentInboxItemView, type AgentView, type AutoSentItemView } from '@/lib/api';

type QueueTab = 'pending' | 'auto-sent' | 'history';

const TABS: Array<{ value: QueueTab; label: string; hint: string }> = [
  {
    value: 'pending',
    label: 'Pending',
    hint: 'The queue — drafts and cleanup batches waiting for your approve/reject',
  },
  {
    value: 'auto-sent',
    label: 'Auto-sent',
    hint: 'Mail policy let an agent send without per-message approval — review it after the fact, revoke trust in one click',
  },
  {
    value: 'history',
    label: 'History',
    hint: 'Every approval and rejection, attributed and kept for audit',
  },
];

export default function AgentInboxPage() {
  const inbox = useAgentInbox();
  const agents = useAgents();
  const workspaceId = inbox.workspace?.workspace_id ?? null;
  const autoSent = useAutoSent(workspaceId);
  const trusted = useTrustedCorrespondents(workspaceId);

  const [tab, setTab] = useState<QueueTab>('pending');
  const [trustedOpen, setTrustedOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ReviewSubject | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const changeTab = useCallback(
    (next: QueueTab) => {
      setTab(next);
      if (next === 'pending') inbox.setState('pending');
      else if (next === 'history') inbox.setState('history');
      // 'auto-sent' reads its own hook; the queue slice stays as-is.
    },
    [inbox],
  );

  const agentFor = useCallback(
    (key: string | null): AgentView | null =>
      key ? agents.items.find((a) => a.key === key) ?? null : null,
    [agents.items],
  );

  const openReview = useCallback((subject: ReviewSubject) => {
    setReviewing(subject);
    setReviewOpen(true);
  }, []);
  const closeReview = useCallback(() => setReviewOpen(false), []);

  const refreshActive = useCallback(() => {
    if (tab === 'auto-sent') void autoSent.refresh();
    else void inbox.refresh();
  }, [tab, autoSent, inbox]);

  const activeLoading =
    tab === 'auto-sent' ? autoSent.load === 'loading' : inbox.load === 'loading';

  // The reviewed queue item, re-resolved from the live list so a decided item's
  // state flip (pending → approved) reflects if the panel stays open mid-refresh.
  const reviewingItem =
    reviewing?.kind === 'item'
      ? inbox.items.find((it) => it.id === reviewing.item.id) ?? reviewing.item
      : null;
  const reviewSubject: ReviewSubject | null =
    reviewing === null
      ? null
      : reviewing.kind === 'item'
        ? { kind: 'item', item: reviewingItem ?? reviewing.item }
        : reviewing;
  const reviewPending = reviewSubject?.kind === 'item' && reviewSubject.item.state === 'pending';

  const tabCount = (t: QueueTab): number | null => {
    if (t === 'pending') return inbox.pendingCount;
    if (t === 'auto-sent') return autoSent.load === 'ready' ? autoSent.items.length : null;
    return t === tab && inbox.state === 'history' && inbox.load === 'ready'
      ? inbox.items.length
      : null;
  };

  return (
    <div className="space-y-7">
      <Hero
        pendingCount={inbox.pendingCount}
        loading={activeLoading}
        onRefresh={refreshActive}
        onOpenTrusted={() => setTrustedOpen(true)}
      />

      {!inbox.workspace && inbox.load === 'ready' ? (
        <NoWorkspace />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs tab={tab} counts={tabCount} onChange={changeTab} />
            {tab !== 'auto-sent' && inbox.load === 'ready' && inbox.items.length > 0 && (
              <span className="font-mono text-xs text-muted">
                {inbox.items.length} {inbox.items.length === 1 ? 'item' : 'items'}
              </span>
            )}
          </div>

          {tab === 'auto-sent' ? (
            <AutoSentList
              autoSent={autoSent}
              onSelect={(item) => openReview({ kind: 'auto-sent', item })}
            />
          ) : inbox.load === 'loading' ? (
            <QueueSkeleton />
          ) : inbox.load === 'error' ? (
            <ErrorState message={inbox.error} onRetry={() => void inbox.refresh()} />
          ) : inbox.items.length === 0 ? (
            <EmptyState tab={tab} />
          ) : (
            <div className="space-y-3">
              {inbox.items.map((item) => (
                <ReviewCard
                  key={item.id}
                  item={item}
                  onOpen={() => openReview({ kind: 'item', item })}
                  onApprove={(note) => inbox.approve(item.id, note)}
                  onReject={(note) => inbox.reject(item.id, note)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <ReviewPanel
        open={reviewOpen}
        onClose={closeReview}
        workspaceId={workspaceId}
        subject={reviewSubject}
        agent={agentFor(
          reviewSubject?.kind === 'auto-sent'
            ? reviewSubject.item.agent_key
            : reviewSubject?.item.drafted_by ?? null,
        )}
        trusted={trusted}
        onApprove={
          reviewPending
            ? (note, trustRecipients) =>
                inbox.approve(
                  (reviewSubject as Extract<ReviewSubject, { kind: 'item' }>).item.id,
                  note,
                  trustRecipients !== undefined ? { trustRecipients } : undefined,
                )
            : undefined
        }
        onReject={
          reviewPending
            ? (note) =>
                inbox.reject(
                  (reviewSubject as Extract<ReviewSubject, { kind: 'item' }>).item.id,
                  note,
                )
            : undefined
        }
      />

      <TrustedCorrespondentsDialog
        open={trustedOpen}
        onOpenChange={setTrustedOpen}
        trusted={trusted}
      />
    </div>
  );
}

function Hero({
  pendingCount,
  loading,
  onRefresh,
  onOpenTrusted,
}: {
  pendingCount: number;
  loading: boolean;
  onRefresh: () => void;
  onOpenTrusted: () => void;
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
              Open any item to see the full email — rendered exactly as the recipient will —
              before it sends. Cleanup batches show every message they touch. Policy-auto-sent
              mail lands in Auto-sent for after-the-fact review.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row lg:items-center">
            <Tooltip content="The allowlist behind auto-replies — who agents may answer without per-message approval">
              <Button variant="secondary" onClick={onOpenTrusted}>
                Trusted senders
              </Button>
            </Tooltip>
            <Tooltip content="Refetch the active tab from the server">
              <Button variant="secondary" onClick={onRefresh} disabled={loading}>
                Refresh queue
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
    </header>
  );
}

function Tabs({
  tab,
  counts,
  onChange,
}: {
  tab: QueueTab;
  counts: (t: QueueTab) => number | null;
  onChange: (next: QueueTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Agent inbox filter"
      className="inline-flex rounded-token border border-subtle bg-surface-raised p-1"
    >
      {TABS.map((t) => {
        const active = t.value === tab;
        const count = counts(t.value);
        return (
          <Tooltip key={t.value} content={t.hint} bubbleClassName="max-w-[300px]">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.value)}
              className={cn(
                'inline-flex min-h-[36px] items-center gap-2 rounded-token px-3 text-sm font-medium transition-colors duration-fast ease-token',
                active
                  ? 'bg-surface-overlay text-primary shadow-token'
                  : 'text-tertiary hover:text-primary',
              )}
            >
              {t.label}
              {t.value === 'pending' && count !== null && count > 0 && (
                <Badge variant="review" className="font-mono">
                  {count}
                </Badge>
              )}
              {t.value !== 'pending' && count !== null && count > 0 && (
                <span className="font-mono text-[10.5px] text-muted">{count}</span>
              )}
            </button>
          </Tooltip>
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
  onOpen,
  onApprove,
  onReject,
}: {
  item: AgentInboxItemView;
  /** Open the full-fidelity review panel for this item. */
  onOpen: () => void;
  onApprove: (note?: string) => Promise<{ ok: boolean; error?: string }>;
  onReject: (note?: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const confirm = useConfirm();
  const meta = useMemo(() => kindMeta(item.kind), [item.kind]);
  const targets = useMemo(
    () => (item.kind === 'CLEANUP' ? deriveCleanupTargets(item.payload) : null),
    [item.kind, item.payload],
  );
  const policy = useMemo(() => holdPolicyOf(item.payload), [item.payload]);
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
        {/* The summary is a button: selecting an item opens the full review. */}
        <button
          type="button"
          onClick={onOpen}
          title={item.kind === 'CLEANUP' ? 'Review the full batch' : 'Review the full email'}
          className="group min-w-0 flex-1 rounded-token text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={meta.badge}>{meta.label}</Badge>
            <StateBadge state={item.state} />
            <span className="inline-flex items-center gap-1.5 text-[11px] text-tertiary">
              <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
              <span className="font-mono">{agentLabel(item.drafted_by)}</span>
            </span>
            <RelativeTime iso={item.created_at} className="text-[11px] text-muted" />
          </div>

          <p className="mt-3 truncate text-sm font-medium text-primary group-hover:text-accent">
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
          {item.kind === 'CLEANUP' && cleanupReason(item.payload) && (
            <p className="mt-1.5 text-xs leading-5 text-tertiary">
              <span className="font-medium text-secondary">Why:</span> {cleanupReason(item.payload)}
            </p>
          )}
          {pending && policy && policy.reasons.length > 0 && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-warning">
              <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
              <span className="min-w-0">
                {policy.reasons[0].message}{' '}
                <Link
                  href="/help#autonomy-trust"
                  onClick={(e) => e.stopPropagation()}
                  className="whitespace-nowrap font-medium text-accent hover:underline"
                >
                  Learn more
                </Link>
              </span>
            </p>
          )}

          <span className="mt-2 inline-block text-[11px] font-medium text-accent opacity-80 transition-opacity group-hover:opacity-100">
            {item.kind === 'CLEANUP' ? 'Review every affected message →' : 'Review the full email →'}
          </span>

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
        </button>

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

// ── Auto-sent lane ───────────────────────────────────────────────────────────

function AutoSentList({
  autoSent,
  onSelect,
}: {
  autoSent: ReturnType<typeof useAutoSent>;
  onSelect: (item: AutoSentItemView) => void;
}) {
  if (autoSent.load === 'loading') return <QueueSkeleton />;
  if (autoSent.load === 'absent') {
    return (
      <Card padded>
        <p className="text-sm font-medium text-primary">The auto-sent audit lane isn’t live here yet.</p>
        <p className="mt-1 text-sm text-tertiary">
          This server doesn’t expose policy-auto-sent mail yet — it arrives with the Wave-7
          backend. Until then, nothing sends without landing in your Pending queue first.
        </p>
      </Card>
    );
  }
  if (autoSent.load === 'error') {
    return <ErrorState message={autoSent.error} onRetry={() => void autoSent.refresh()} />;
  }
  if (autoSent.items.length === 0) {
    return (
      <Card padded>
        <p className="text-sm font-medium text-primary">Nothing has auto-sent.</p>
        <p className="mt-1 text-sm text-tertiary">
          When a policy lets an agent send without per-message approval — for example to a
          trusted correspondent — the sent email lands here for after-the-fact review.
        </p>
        <Link
          href="/help#autonomy-trust"
          className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
        >
          When do agents auto-send? →
        </Link>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {autoSent.items.map((item) => (
        <AutoSentRow key={item.id} item={item} onSelect={() => onSelect(item)} />
      ))}
    </div>
  );
}

function AutoSentRow({ item, onSelect }: { item: AutoSentItemView; onSelect: () => void }) {
  const to = item.message?.to_addresses ?? [];
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onSelect}
        title="Review this auto-sent email"
        className="group block w-full p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="protected">auto-sent</Badge>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-tertiary">
            <span className="grid h-[16px] w-[16px] place-items-center rounded bg-accent text-white">
              <RobotIcon className="h-[10px] w-[10px]" />
            </span>
            <span className="font-mono">{agentLabel(item.agent_key)}</span>
          </span>
          <RelativeTime iso={item.created_at} className="text-[11px] text-muted" />
        </div>
        <p className="mt-3 truncate text-sm font-medium text-primary group-hover:text-accent">
          {item.message?.subject || item.detail || '(no subject)'}
        </p>
        {to.length > 0 && (
          <p className="mt-1 truncate font-mono text-xs text-tertiary">to {to.join(', ')}</p>
        )}
        {item.detail && item.message?.subject && (
          <p className="mt-1.5 truncate text-xs leading-5 text-tertiary">{item.detail}</p>
        )}
        <span className="mt-2 inline-block text-[11px] font-medium text-accent opacity-80 transition-opacity group-hover:opacity-100">
          Review what went out →
        </span>
      </button>
    </Card>
  );
}

// ── Shared chrome ────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
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

function EmptyState({ tab }: { tab: QueueTab }) {
  if (tab === 'pending') {
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
            <Link
              href="/help#approvals"
              className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
            >
              How the approval queue works →
            </Link>
          </div>
        </div>
      </Card>
    );
  }
  return (
    <Card padded>
      <p className="text-sm text-tertiary">
        No decisions yet. Approvals and rejections you make on the Pending tab show up here.
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
