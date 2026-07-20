'use client';

/**
 * The violet inline "an agent drafted a reply" card, rendered above the body in
 * the reader when the open thread has a PENDING agent-inbox item.
 *
 * Violet is the command center's one signal that an agent touched this. The card
 * shows the drafting agent, its autonomy level, the drafted text, and the three
 * real decisions — Approve & send / Edit / Discard — wired to the live
 * agent-inbox approve / reject endpoints (Approve SENDS; Discard rejects, never
 * sends; Edit opens the draft in the composer so a human can adjust and send).
 */

import Link from 'next/link';
import { useState } from 'react';
import { cn } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { agentLabel } from '@/lib/agents';
import type { AgentInboxItemView } from '@/lib/api';
import { RobotIcon, SendSolidIcon } from './icons';

export function AgentDraftCard({
  item,
  autonomyLabel,
  onApprove,
  onEdit,
  onDiscard,
}: {
  item: AgentInboxItemView;
  /** e.g. "L1 · APPROVE TO SEND" — the drafting agent's autonomy / hold reason. */
  autonomyLabel: string;
  onApprove: () => Promise<{ ok: boolean; error?: string }>;
  onEdit: () => void;
  onDiscard: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [busy, setBusy] = useState<null | 'approve' | 'discard'>(null);
  const [error, setError] = useState<string | null>(null);

  const text = item.body_preview?.trim() || item.summary?.trim() || 'The agent staged a reply for your approval.';

  const run = async (kind: 'approve' | 'discard', fn: () => Promise<{ ok: boolean; error?: string }>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    const res = await fn();
    if (!res.ok) {
      setError(res.error ?? 'Could not complete that. Try again.');
      setBusy(null);
    }
    // On success the item leaves the pending queue and this card unmounts.
  };

  return (
    <div className="mx-6 mb-5 mt-1 overflow-hidden rounded-token-lg border border-accent/35 bg-gradient-to-b from-accent/[0.08] to-accent/[0.02]">
      <div className="flex items-center gap-2.5 border-b border-accent/20 px-4 py-3">
        <span className="grid h-[22px] w-[22px] place-items-center rounded-md bg-accent text-white">
          <RobotIcon className="h-[13px] w-[13px]" />
        </span>
        <span className="text-[13px] font-semibold text-primary">
          {agentLabel(item.drafted_by)} drafted a reply
        </span>
        <Tooltip
          content="The drafting agent's autonomy level — why this draft is waiting on you. Click for the full autonomy & trust guide."
          bubbleClassName="max-w-[300px]"
        >
          <Link
            href="/help#autonomy-trust"
            className="ml-auto rounded-md bg-warning/[0.14] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] text-warning transition-colors hover:bg-warning/[0.22] mono"
          >
            {autonomyLabel}
          </Link>
        </Tooltip>
      </div>

      <div className="px-4 py-3.5 text-[13px] leading-[1.6] text-secondary">
        {item.subject && (
          <p className="mb-1.5 truncate text-[11px] font-medium uppercase tracking-wide text-tertiary">
            {item.subject}
            {item.to_address && <span className="ml-2 normal-case text-muted mono">→ {item.to_address}</span>}
          </p>
        )}
        <p className="whitespace-pre-wrap">{text}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5">
        <Tooltip content="Send exactly this text to the recipient — it can't be unsent">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('approve', onApprove)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-semibold text-white shadow-[0_2px_8px_-2px_rgb(var(--accent)/0.5)] transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            <SendSolidIcon className="h-[14px] w-[14px]" />
            {busy === 'approve' ? 'Sending…' : 'Approve & send'}
          </button>
        </Tooltip>
        <Tooltip content="Open the draft in the composer — adjust it and send it yourself">
          <button
            type="button"
            disabled={busy !== null}
            onClick={onEdit}
            className="inline-flex h-8 items-center rounded-lg border border-border px-3.5 text-[12px] font-semibold text-secondary transition-colors hover:border-muted hover:text-primary disabled:opacity-50"
          >
            Edit
          </button>
        </Tooltip>
        <Tooltip content="Reject the draft — it never sends; the decision is kept for audit">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('discard', onDiscard)}
            className="inline-flex h-8 items-center rounded-lg border border-transparent px-3.5 text-[12px] font-semibold text-secondary transition-colors hover:text-primary disabled:opacity-50"
          >
            {busy === 'discard' ? 'Discarding…' : 'Discard'}
          </button>
        </Tooltip>
        {error && <span className={cn('text-[11px] text-danger')}>{error}</span>}
      </div>
    </div>
  );
}
