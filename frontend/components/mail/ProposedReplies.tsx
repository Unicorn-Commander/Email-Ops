'use client';

/**
 * ProposedReplies — the "emails with proposed responses" surface.
 *
 * Renders the pending EMAIL-kind agent-inbox items as reply cards in the daily
 * brief (the reader pane when no thread is open), so "where do I check proposed
 * responses" is self-answering: each card shows WHO drafted (agent avatar chip),
 * FOR WHOM (→ recipient), WHAT (subject + 2-line preview), WHEN it was staged,
 * and the real decisions. Review opens the thread / queue; the optional quick
 * actions wire straight to the live approve (SENDS) / reject (never sends)
 * endpoints and report truthfully — a card only leaves when the refreshed queue
 * confirms the decision, never on an optimistic "done".
 *
 * Purely presentational: fetching stays in `useAgentInbox`; the page passes
 * `inbox.items.filter(isProposedReply)` (or a slice of it, with `totalCount`).
 * Violet is the house "an agent touched this" signal, so the cards sit on the
 * same accent-tinted gradient language as AgentDraftCard — one notch quieter.
 * Helpers (hue avatar, initials, terse timestamps) are copied locally so this
 * file stays self-contained rather than importing page internals.
 */

import { useState, type CSSProperties } from 'react';
import { cn } from '@/components/ui';
import { agentLabel } from '@/lib/agents';
import type { AgentInboxItemView } from '@/lib/api';
import { RobotIcon, SendSolidIcon } from './icons';

/** Result of a quick approve/reject — mirrors useAgentInbox's ReviewOutcome. */
export interface ProposedReplyOutcome {
  ok: boolean;
  error?: string;
}

export interface ProposedRepliesProps {
  /**
   * Pending agent-inbox items. The component re-filters with `isProposedReply`
   * defensively, so passing the raw pending list is safe.
   */
  items: AgentInboxItemView[];
  /** Open the item for full review (its thread with the draft card, or the queue). */
  onReview: (item: AgentInboxItemView) => void;
  /** Optional quick action — approving SENDS the reply. Omit to hide the button. */
  onApprove?: (item: AgentInboxItemView) => Promise<ProposedReplyOutcome>;
  /** Optional quick action — discarding rejects the draft (it is never sent). */
  onReject?: (item: AgentInboxItemView) => Promise<ProposedReplyOutcome>;
  /** Total pending proposed replies when `items` is a slice — shows "+N more". */
  totalCount?: number;
  /** Open the full approvals queue (target of the "+N more" line). */
  onViewAll?: () => void;
  className?: string;
}

/**
 * The one EMAIL-vs-CLEANUP rule, mirroring the page's PendingTargetLine
 * discrimination: anything not explicitly a CLEANUP batch is a proposed reply
 * (older items predate the `kind` field). Includes the pending check so it can
 * be applied to `inbox.items` directly.
 */
export function isProposedReply(item: AgentInboxItemView): boolean {
  return item.state === 'pending' && item.kind !== 'CLEANUP';
}

// ── Self-contained display helpers (copied from the page's house rules) ───────

/** Deterministic hue for a seed string (matches the page's addressHue). */
function seedHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** Same-hue gradient avatar fill — the agent reads the same colour everywhere. */
function avatarHueStyle(seed: string): CSSProperties {
  const h = seedHue((seed || 'x').toLowerCase());
  return { background: `linear-gradient(140deg, hsl(${h} 70% 56%), hsl(${h} 62% 45%))` };
}

/** Two-letter monogram for an agent display name. */
function initials(name?: string | null, fallback?: string | null): string {
  const n = name?.trim();
  if (n) {
    const parts = n.split(/[\s\-_]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  const f = fallback?.trim();
  if (f) return f.slice(0, 2).toUpperCase();
  return '··';
}

/** Terse Superhuman-style stamp (now / 5m / 3h / 2d / "Jul 4"), like formatWhen. */
function stagedWhen(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── One reply card ────────────────────────────────────────────────────────────

function ReplyCard({
  item,
  onReview,
  onApprove,
  onReject,
}: {
  item: AgentInboxItemView;
  onReview: () => void;
  onApprove?: () => Promise<ProposedReplyOutcome>;
  onReject?: () => Promise<ProposedReplyOutcome>;
}) {
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);

  const agent = agentLabel(item.drafted_by);
  const subject = item.subject?.trim() || '(no subject)';
  const preview =
    item.body_preview?.trim() ||
    item.summary?.trim() ||
    'The agent staged a reply for your approval.';
  const when = stagedWhen(item.created_at);

  const run = async (
    kind: 'approve' | 'reject',
    fn?: () => Promise<ProposedReplyOutcome>,
  ) => {
    if (!fn || busy) return;
    setBusy(kind);
    setError(null);
    const res = await fn();
    if (!res.ok) {
      setError(res.error ?? 'Could not complete that. Try again.');
      setBusy(null);
    }
    // On success the item leaves the pending queue and this card unmounts —
    // the refreshed list is the confirmation, never an optimistic "done".
  };

  return (
    <article
      className="overflow-hidden rounded-token-lg border border-accent/25 bg-gradient-to-b from-accent/[0.06] to-transparent"
      aria-label={`Proposed reply from ${agent}: ${subject}`}
    >
      {/* Provenance header: who drafted, for whom, staged when. */}
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
          style={avatarHueStyle(item.drafted_by || item.id)}
          aria-hidden
        >
          {initials(agent, item.drafted_by)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] leading-[1.4] text-secondary">
            <b className="font-semibold text-primary">{agent}</b> proposed a reply
          </span>
          {item.to_address && (
            <span className="mt-px block truncate text-[11px] text-tertiary mono">
              → {item.to_address}
            </span>
          )}
        </span>
        {when && (
          <span className="shrink-0 pt-0.5 text-[11px] text-tertiary mono" title="Staged">
            {when}
          </span>
        )}
      </div>

      {/* The email itself — the whole block opens the full review. */}
      <button
        type="button"
        onClick={onReview}
        className="block w-full px-3.5 pb-1.5 pt-2.5 text-left transition-colors hover:bg-accent/[0.05]"
        aria-label={`Open and review: ${subject}`}
      >
        <span className="block truncate text-[13px] font-semibold text-primary">{subject}</span>
        <span className="mt-1 line-clamp-2 text-[12px] leading-[1.55] text-secondary">
          {preview}
        </span>
      </button>

      {/* Decisions. One solid button per card (Review); quick actions stay quiet. */}
      <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3 pt-1.5">
        <button
          type="button"
          disabled={busy !== null}
          onClick={onReview}
          className="inline-flex h-8 items-center rounded-lg bg-accent px-3.5 text-[12px] font-semibold text-white shadow-[0_2px_8px_-2px_rgb(var(--accent)/0.5)] transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          Review draft
        </button>
        {onApprove && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('approve', onApprove)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3.5 text-[12px] font-semibold text-secondary transition-colors hover:border-accent/60 hover:text-primary disabled:opacity-50"
          >
            <SendSolidIcon className="h-[13px] w-[13px]" />
            {busy === 'approve' ? 'Sending…' : 'Approve & send'}
          </button>
        )}
        {onReject && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('reject', onReject)}
            className="inline-flex h-8 items-center rounded-lg border border-transparent px-3 text-[12px] font-semibold text-tertiary transition-colors hover:text-primary disabled:opacity-50"
          >
            {busy === 'reject' ? 'Discarding…' : 'Discard'}
          </button>
        )}
        {error && (
          <span role="alert" className="text-[11px] text-danger">
            {error}
          </span>
        )}
      </div>
    </article>
  );
}

// ── The section ───────────────────────────────────────────────────────────────

export function ProposedReplies({
  items,
  onReview,
  onApprove,
  onReject,
  totalCount,
  onViewAll,
  className,
}: ProposedRepliesProps) {
  const replies = items.filter(isProposedReply);
  const total =
    typeof totalCount === 'number' ? Math.max(totalCount, replies.length) : replies.length;

  return (
    <section className={className} aria-label="Proposed replies">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
          Proposed replies
        </p>
        {total > 0 && (
          <span className="rounded-full bg-surface-overlay px-1.5 py-0.5 text-[10px] font-semibold leading-none text-secondary mono">
            {total}
          </span>
        )}
      </div>

      {replies.length === 0 ? (
        <div className="flex items-center gap-3 rounded-token border border-subtle bg-surface-base/50 px-4 py-3.5">
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/12 text-accent"
            aria-hidden
          >
            <RobotIcon className="h-4 w-4" />
          </span>
          <p className="text-[13px] leading-[1.5] text-secondary">
            No proposed replies yet — agents draft answers here for your approval.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {replies.map((it) => (
            <ReplyCard
              key={it.id}
              item={it}
              onReview={() => onReview(it)}
              onApprove={onApprove ? () => onApprove(it) : undefined}
              onReject={onReject ? () => onReject(it) : undefined}
            />
          ))}
          {total > replies.length && onViewAll && (
            <button
              type="button"
              onClick={onViewAll}
              className="px-1 pt-0.5 text-[12px] font-medium text-accent hover:underline"
            >
              +{total - replies.length} more in approvals →
            </button>
          )}
        </div>
      )}
    </section>
  );
}
