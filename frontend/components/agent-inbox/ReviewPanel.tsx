'use client';

/**
 * ReviewPanel — the full-fidelity, draft-style review for an agent-inbox item
 * (Wave 7). Selecting a queue item opens this: THE FULL EMAIL exactly as the
 * recipient will see it — sanitized rendered HTML body (the same DOMPurify +
 * sandboxed-iframe pipeline as the mail reader), every recipient row, subject,
 * the drafting agent + autonomy, the hold-reason banner, attachment chips with
 * authenticated downloads, and an "open thread" jump into /mail.
 *
 * Three subjects share the one panel:
 *   - a PENDING queue item  → review + Approve / Reject (with the first-contact
 *     "trust this correspondent" choice wired to the approve call);
 *   - a DECIDED queue item  → the same read, plus who decided and when;
 *   - an AUTO-SENT audit row → read-only, plus per-recipient "revoke trust".
 *
 * CLEANUP items render the full affected-message list (never a bare count):
 * every row the staged plan captured — sender, subject, date, size — with the
 * protected-kept set behind an expander.
 *
 * Fidelity sourcing is progressive: the panel renders instantly from the list
 * item, then hydrates from the Wave-7 detail read; a pre-Wave-7 backend (404)
 * keeps the degraded view with an honest notice. House rule: nothing shows as
 * done until the API confirms.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, cn, useConfirm } from '@/components/ui';
import { HtmlEmailBody } from '@/components/mail/HtmlEmailBody';
import {
  AttachmentGlyph,
  MessageAttachments,
  formatBytes,
} from '@/components/mail/AttachmentList';
import {
  CleanupTargetsList,
  cleanupTargetsSentence,
} from '@/components/mail/CleanupTargetsList';
import { CloseIcon, PopOutIcon } from '@/components/mail/icons';
import { AgentAvatar } from '@/components/AgentAvatar';
import { formatWhen } from '@/components/mail/useMailClient';
import { useUiCommands } from '@/components/UiCommandProvider';
import { agentLabel } from '@/lib/agents';
import { cleanupReason, deriveCleanupTargets, remainingCount } from '@/lib/cleanupTargets';
import { fetchMailBlob, type MailAttachment } from '@/lib/mailApi';
import {
  getAgentInboxItemDetail,
  holdPolicyOf,
  coerceStagedMessage,
  ApiError,
  type AgentInboxItemView,
  type AgentView,
  type AutoSentItemView,
  type AutonomyLevel,
  type HoldPolicyView,
  type StagedAttachmentView,
  type StagedMessageView,
} from '@/lib/api';
import type { ReviewOutcome } from '@/components/useAgentInbox';
import { bareAddress, type UseTrustedCorrespondents } from './TrustedCorrespondents';

// ── Subject: what the panel is reviewing ─────────────────────────────────────

export type ReviewSubject =
  | { kind: 'item'; item: AgentInboxItemView }
  | { kind: 'auto-sent'; item: AutoSentItemView };

const AUTONOMY_SHORT: Record<AutonomyLevel, string> = {
  L0_DRAFT_ONLY: 'L0 · draft only',
  L1_APPROVE_TO_SEND: 'L1 · approve to send',
  L2_AUTONOMOUS_AUDIT: 'L2 · autonomous',
};

/** Hold-reason codes/wording that mean "the recipient isn't trusted yet". */
const TRUSTABLE_REASON_RE =
  /first[\s_-]?contact|untrust|not[\s_-]?(yet[\s_-]?)?trusted|unknown[\s_-]?(recipient|correspondent|sender)|new[\s_-]?(recipient|correspondent|contact)|external[\s_-]?recipient/i;
const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * The addresses an approval would trust: named in the matching hold reasons
 * when possible, else every staged recipient. Empty = no trust choice to show.
 */
function trustTargets(
  policy: HoldPolicyView | null,
  message: StagedMessageView | null,
  fallbackTo: string | null,
): string[] {
  const reasons = (policy?.reasons ?? []).filter(
    (r) => TRUSTABLE_REASON_RE.test(r.code) || TRUSTABLE_REASON_RE.test(r.message),
  );
  if (reasons.length === 0) return [];
  const out: string[] = [];
  const push = (raw: string) => {
    const a = bareAddress(raw);
    if (a && a.includes('@') && !out.includes(a)) out.push(a);
  };
  for (const r of reasons) {
    for (const m of r.message.match(EMAIL_IN_TEXT_RE) ?? []) push(m);
  }
  if (out.length === 0) {
    for (const a of message?.to_addresses ?? []) push(a);
    for (const a of message?.cc_addresses ?? []) push(a);
    if (out.length === 0 && fallbackTo) push(fallbackTo);
  }
  return out;
}

function payloadStr(
  payload: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!payload) return null;
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** A list-shaped queue item as a (degraded) staged message — instant render. */
function degradedMessage(item: AgentInboxItemView): StagedMessageView {
  return {
    subject: item.subject,
    from_address: null,
    to_addresses: item.to_address ? [item.to_address] : [],
    cc_addresses: [],
    html_body: null,
    text_body: null,
    attachments: [],
    thread_id: payloadStr(item.payload, ['thread_id', 'in_reply_to_thread_id', 'conversation_id']),
    mailbox_id: payloadStr(item.payload, ['mailbox_id', 'mailbox_account_id', 'from_mailbox_id']),
  };
}

// ── Small presentational pieces ──────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
  if (state === 'approved') return <Badge variant="success">approved</Badge>;
  if (state === 'rejected') return <Badge variant="danger">rejected</Badge>;
  return <Badge variant="warning">pending</Badge>;
}

/** One labelled recipient row (From / To / Cc): label gutter + mono chips. */
function AddressRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="w-9 shrink-0 text-right text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap gap-1">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex max-w-full items-center rounded-token bg-surface-overlay px-1.5 py-0.5 font-mono text-[11.5px] leading-5 text-secondary"
            title={v}
          >
            <span className="truncate">{v}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Read-only chips for staged attachments that aren't downloadable (yet). */
function StagedAttachmentChips({ items }: { items: StagedAttachmentView[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((att, i) => (
        <span
          key={`${att.name ?? 'attachment'}-${i}`}
          className="inline-flex max-w-[16rem] items-center gap-2 rounded-token border border-subtle bg-surface-overlay/60 p-1.5 pr-2.5"
          title={att.name ?? 'attachment'}
        >
          <AttachmentGlyph att={att} />
          <span className="flex min-w-0 flex-col text-left">
            <span className="truncate text-xs text-secondary">{att.name ?? 'attachment'}</span>
            <span className="flex items-center gap-1.5 text-[10px] leading-4 text-muted">
              {att.size != null && <span className="font-mono">{formatBytes(att.size)}</span>}
              {att.type && <span className="truncate">{att.type}</span>}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}

/** The hold-policy banner: WHY this draft stopped for a human. */
function HoldBanner({ policy, pending }: { policy: HoldPolicyView; pending: boolean }) {
  if (policy.reasons.length === 0) return null;
  return (
    <div
      className={cn(
        'rounded-token border p-3',
        pending ? 'border-warning/35 bg-warning-subtle/60' : 'border-subtle bg-surface-base/50',
      )}
    >
      <p
        className={cn(
          'text-[11px] font-semibold uppercase tracking-wide',
          pending ? 'text-warning' : 'text-tertiary',
        )}
      >
        {pending ? 'Held for your approval' : 'Why this was held'}
      </p>
      <ul className="mt-1.5 space-y-1">
        {policy.reasons.map((r, i) => (
          <li key={`${r.code}-${i}`} className="flex items-baseline gap-2 text-[12.5px] leading-5">
            <span
              aria-hidden
              className={cn(
                'mt-1.5 h-1.5 w-1.5 shrink-0 self-start rounded-full',
                pending ? 'bg-warning' : 'bg-muted',
              )}
            />
            <span className="min-w-0 text-secondary">
              {r.message}
              {r.code && r.code !== 'hold' && (
                <span className="ml-1.5 font-mono text-[10px] text-muted">{r.code}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Cleanup: the full affected-message list ──────────────────────────────────

interface AffectedRow {
  sender: string | null;
  subject: string | null;
  date: string | null;
  size: number | null;
  reason: string | null;
}

function coerceAffectedRow(raw: unknown): AffectedRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const sender = str(rec.sender);
  const subject = str(rec.subject);
  if (!sender && !subject) return null;
  const sizeRaw = Number(rec.size_bytes ?? rec.sizeBytes ?? rec.size);
  return {
    sender,
    subject,
    date: str(rec.date),
    size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null,
    reason: str(rec.reason),
  };
}

/** The staged Cleaner-Engine plan's row lists, when the payload carries them. */
function planRows(
  payload: Record<string, unknown> | null | undefined,
  key: 'safe' | 'protected',
): AffectedRow[] {
  const plan = payload?.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return [];
  const list = (plan as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.map(coerceAffectedRow).filter((r): r is AffectedRow => r !== null);
}

function formatRowDate(raw: string): string {
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return raw.length > 12 ? raw.slice(0, 12) : raw;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function AffectedRowLine({ row }: { row: AffectedRow }) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="min-w-0 shrink-0 truncate text-[12px] font-medium text-secondary sm:w-44">
        {row.sender ?? '(unknown sender)'}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-tertiary" title={row.subject ?? undefined}>
        {row.subject ?? '(no subject)'}
      </span>
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-[10.5px] text-muted">
        {row.date && <span>{formatRowDate(row.date)}</span>}
        {row.size != null && <span>{formatBytes(row.size)}</span>}
      </span>
    </li>
  );
}

const AFFECTED_PREVIEW_LIMIT = 10;

/**
 * Everything a cleanup batch touches, itemized. Sources, in order of fidelity:
 * the staged plan's full safe/protected row lists, else the bounded `targets`
 * preview — with an honest "+N not itemized" when the capture was bounded.
 */
function CleanupAffectedList({ item }: { item: AgentInboxItemView }) {
  const payload = item.payload ?? null;
  const targets = useMemo(() => deriveCleanupTargets(payload), [payload]);
  const safe = useMemo(() => planRows(payload, 'safe'), [payload]);
  const kept = useMemo(() => planRows(payload, 'protected'), [payload]);
  const reason = cleanupReason(payload);
  const [showAll, setShowAll] = useState(false);
  const [showKept, setShowKept] = useState(false);

  const folder = payloadStr(payload, ['folder']);
  const rows = safe;
  const visible = showAll ? rows : rows.slice(0, AFFECTED_PREVIEW_LIMIT);

  return (
    <div className="space-y-3.5">
      {targets && <CleanupTargetsList targets={targets} />}
      {reason && (
        <p className="text-xs leading-5 text-tertiary">
          <span className="font-medium text-secondary">Why:</span> {reason}
        </p>
      )}
      {folder && (
        <p className="text-xs text-tertiary">
          <span className="font-medium text-secondary">Destination:</span>{' '}
          <span className="font-mono">{folder}</span>
        </p>
      )}

      {rows.length > 0 ? (
        <section>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
            Every message affected ({rows.length.toLocaleString()})
          </p>
          <ul className="mt-1 divide-y divide-[rgb(var(--border-subtle)/0.55)]">
            {visible.map((row, i) => (
              <AffectedRowLine key={i} row={row} />
            ))}
          </ul>
          {rows.length > AFFECTED_PREVIEW_LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-1.5 text-[11.5px] font-medium text-accent transition-colors hover:underline"
            >
              {showAll ? 'Show fewer' : `Show all ${rows.length.toLocaleString()}`}
            </button>
          )}
        </section>
      ) : targets && targets.rows.length > 0 ? (
        <section>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
            Itemized targets
          </p>
          <ul className="mt-1 divide-y divide-[rgb(var(--border-subtle)/0.55)]">
            {targets.rows.map((row, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-[12px] text-secondary">
                  {targets.scope === 'threads'
                    ? row.subject || '(no subject)'
                    : row.sender || '(unknown sender)'}
                  {targets.scope === 'threads' && row.sender && (
                    <span className="ml-1.5 text-muted">· {row.sender}</span>
                  )}
                </span>
                {row.count != null && (
                  <span className="shrink-0 font-mono text-[10.5px] text-muted">
                    {row.count.toLocaleString()} message{row.count === 1 ? '' : 's'}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {remainingCount(targets) > 0 && (
            <p className="mt-1.5 text-[11px] text-muted">
              + {remainingCount(targets).toLocaleString()} more not itemized — this batch was
              staged with a bounded preview.
            </p>
          )}
        </section>
      ) : (
        <p className="text-xs italic text-muted">
          This batch carries no per-message itemization ({item.summary ?? 'no summary'}). It was
          staged before full target capture — reject it and re-stage if you need the exact list.
        </p>
      )}

      {kept.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setShowKept((v) => !v)}
            aria-expanded={showKept}
            className="text-[11.5px] font-medium text-tertiary transition-colors hover:text-primary"
          >
            {showKept ? 'Hide' : 'Show'} {kept.length.toLocaleString()} protected message
            {kept.length === 1 ? '' : 's'} deliberately kept
          </button>
          {showKept && (
            <ul className="mt-1 divide-y divide-[rgb(var(--border-subtle)/0.55)] rounded-token border border-subtle bg-surface-base/40 px-2.5">
              {kept.map((row, i) => (
                <AffectedRowLine key={i} row={row} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

// ── The panel ────────────────────────────────────────────────────────────────

export function ReviewPanel({
  open,
  onClose,
  workspaceId,
  subject,
  agent,
  trusted,
  onApprove,
  onReject,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string | null;
  subject: ReviewSubject | null;
  /** The drafting fleet agent, when resolvable (drives the autonomy chip). */
  agent: AgentView | null;
  /** Shared trusted-correspondents store (revoke actions; null = not wired). */
  trusted: UseTrustedCorrespondents | null;
  /** Pending queue items only — approve (note, trustRecipients) / reject (note). */
  onApprove?: (note: string | undefined, trustRecipients: boolean | undefined) => Promise<ReviewOutcome>;
  onReject?: (note: string | undefined) => Promise<ReviewOutcome>;
}) {
  const confirm = useConfirm();
  const router = useRouter();
  const { enqueueLocal } = useUiCommands();

  // Mount-then-show so the entrance transition runs (MessagePopout pattern).
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const queueItem = subject?.kind === 'item' ? subject.item : null;
  const auto = subject?.kind === 'auto-sent' ? subject.item : null;
  const isCleanup = queueItem?.kind === 'CLEANUP';
  const subjectKey = subject ? `${subject.kind}:${subject.item.id}` : null;

  // ── Full-fidelity hydration (queue EMAIL items) ───────────────────────────
  type DetailLoad = 'idle' | 'loading' | 'ready' | 'absent' | 'error';
  const [detail, setDetail] = useState<{
    key: string;
    item: AgentInboxItemView | null;
    message: StagedMessageView | null;
  } | null>(null);
  const [detailLoad, setDetailLoad] = useState<DetailLoad>('idle');

  const detailWanted = open && !!workspaceId && !!queueItem && !isCleanup;
  const detailItemId = detailWanted && queueItem ? queueItem.id : null;
  useEffect(() => {
    if (!detailItemId || !workspaceId || !subjectKey) {
      setDetailLoad('idle');
      return;
    }
    let alive = true;
    setDetailLoad('loading');
    void (async () => {
      try {
        const res = await getAgentInboxItemDetail(workspaceId, detailItemId);
        if (!alive) return;
        setDetail({ key: subjectKey, item: res.item, message: res.message });
        setDetailLoad('ready');
      } catch (err) {
        if (!alive) return;
        setDetail(null);
        setDetailLoad(
          err instanceof ApiError && (err.status === 404 || err.status === 501)
            ? 'absent'
            : 'error',
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [detailItemId, workspaceId, subjectKey]);

  // ── Per-subject review state ──────────────────────────────────────────────
  const [note, setNote] = useState('');
  const [trustChoice, setTrustChoice] = useState(true);
  const [acting, setActing] = useState<null | 'approve' | 'reject'>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState<string | null>(null);
  const [revokeNote, setRevokeNote] = useState<string | null>(null);
  useEffect(() => {
    setNote('');
    setTrustChoice(true);
    setActing(null);
    setActionError(null);
    setRevokeBusy(null);
    setRevokeNote(null);
  }, [subjectKey]);

  // ── Resolve what to render ────────────────────────────────────────────────
  const hydrated = detail && detail.key === subjectKey ? detail : null;
  const effectiveItem = hydrated?.item ?? queueItem;
  const message: StagedMessageView | null = useMemo(() => {
    if (auto) return auto.message;
    if (!queueItem || isCleanup) return null;
    return (
      hydrated?.message ??
      coerceStagedMessage(queueItem.payload) ??
      degradedMessage(queueItem)
    );
  }, [auto, queueItem, isCleanup, hydrated]);

  const policy = useMemo(
    () => holdPolicyOf(effectiveItem?.payload ?? null),
    [effectiveItem?.payload],
  );
  const pending = !!queueItem && queueItem.state === 'pending';
  const hasFullBody = !!(message?.html_body || message?.text_body);
  const threadId = message?.thread_id ?? null;
  const blobMailboxId =
    message?.mailbox_id ?? (agent?.mailbox_account_id || null);

  const trustAddresses = useMemo(
    () => (pending && !isCleanup ? trustTargets(policy, message, queueItem?.to_address ?? null) : []),
    [pending, isCleanup, policy, message, queueItem?.to_address],
  );

  const attachments = message?.attachments ?? [];
  const downloadable =
    workspaceId && blobMailboxId ? attachments.filter((a) => a.blob_id) : [];
  const metaOnly = attachments.filter((a) => !downloadable.includes(a));
  const downloadableMail: MailAttachment[] = downloadable.map((a) => ({
    blob_id: a.blob_id as string,
    name: a.name,
    type: a.type,
    size: a.size,
    cid: a.cid,
  }));

  const resolveCid = useCallback(
    async (att: MailAttachment) => {
      if (!workspaceId || !blobMailboxId) throw new Error('No mailbox to resolve inline images.');
      const blob = await fetchMailBlob(workspaceId, blobMailboxId, att.blob_id, att.name, att.type);
      return URL.createObjectURL(blob);
    },
    [workspaceId, blobMailboxId],
  );

  const openThread = useCallback(() => {
    if (!threadId) return;
    enqueueLocal({
      id: `agent-inbox-${Date.now()}`,
      created_at: new Date().toISOString(),
      kind: 'open_thread',
      payload: {
        thread_id: threadId,
        ...(blobMailboxId ? { mailbox_id: blobMailboxId } : {}),
      },
    });
    router.push('/mail');
  }, [threadId, blobMailboxId, enqueueLocal, router]);

  // ── Approve / Reject (pending only; success is API-confirmed, never assumed) ─
  const approveVerb = isCleanup ? 'Run cleanup' : 'Approve & send';
  async function handleApprove() {
    if (!onApprove || !queueItem) return;
    const targets = isCleanup ? deriveCleanupTargets(queueItem.payload) : null;
    const ok = await confirm({
      title: isCleanup ? 'Approve this cleanup batch?' : 'Send this email?',
      description: isCleanup
        ? targets
          ? `${cleanupTargetsSentence(targets)} ${
              targets.verb === 'Permanently delete'
                ? 'A downloadable backup is kept first.'
                : targets.verb === 'Move to Trash'
                  ? 'Trash is reversible.'
                  : 'This moves them out of the inbox.'
            }`
          : `The staged batch will run (${queueItem.summary ?? 'cleanup'}).`
        : `It will be delivered to ${
            message?.to_addresses.join(', ') || queueItem.to_address || 'the recipient'
          }, drafted by ${agentLabel(queueItem.drafted_by)}. This can't be unsent.${
            trustAddresses.length > 0 && trustChoice
              ? ` ${trustAddresses.join(', ')} will be trusted for future auto-replies.`
              : ''
          }`,
      confirmLabel: approveVerb,
      cancelLabel: 'Not yet',
    });
    if (!ok) return;
    setActing('approve');
    setActionError(null);
    const res = await onApprove(
      note.trim() || undefined,
      trustAddresses.length > 0 ? trustChoice : undefined,
    );
    if (!res.ok) {
      setActionError(res.error ?? 'Could not approve.');
      setActing(null);
      return;
    }
    onClose(); // confirmed by the API — the queue refresh already ran
  }

  async function handleReject() {
    if (!onReject || !queueItem) return;
    const ok = await confirm({
      title: `Reject this ${isCleanup ? 'cleanup batch' : 'email'}?`,
      description: `It won't be ${isCleanup ? 'executed' : 'sent'}. The record is kept for audit.`,
      confirmLabel: 'Reject',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setActing('reject');
    setActionError(null);
    const res = await onReject(note.trim() || undefined);
    if (!res.ok) {
      setActionError(res.error ?? 'Could not reject.');
      setActing(null);
      return;
    }
    onClose();
  }

  async function handleRevoke(address: string) {
    if (!trusted) return;
    const addr = bareAddress(address);
    const ok = await confirm({
      title: `Revoke trust for ${addr}?`,
      description:
        'Future agent replies to this correspondent go back through your approval queue. Nothing already sent is affected.',
      confirmLabel: 'Revoke trust',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setRevokeBusy(addr);
    setRevokeNote(null);
    const res = await trusted.removeByAddress(addr);
    setRevokeBusy(null);
    setRevokeNote(res.ok ? `Trust revoked for ${addr}.` : res.error ?? 'Could not revoke trust.');
  }

  if (!mounted || !subject) return null;

  const headerTime = auto ? auto.created_at : queueItem?.created_at ?? null;
  const agentKey = auto ? auto.agent_key : queueItem?.drafted_by ?? null;
  const displaySubject = auto
    ? auto.message?.subject ?? '(no subject)'
    : queueItem?.subject || queueItem?.summary || '(no subject)';
  const recipients = message ? [...message.to_addresses, ...message.cc_addresses] : [];

  return (
    <>
      <button
        type="button"
        aria-label="Close review"
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 cursor-default bg-black/50 backdrop-blur-[3px] transition-opacity duration-token ease-token',
          shown ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={auto ? 'Auto-sent email review' : 'Agent draft review'}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[min(880px,96vw)] flex-col overflow-hidden rounded-[16px] border border-border bg-surface-raised shadow-pop transition-all duration-token ease-token',
          shown
            ? 'pointer-events-auto -translate-x-1/2 -translate-y-1/2 scale-100 opacity-100'
            : 'pointer-events-none -translate-x-1/2 -translate-y-[48%] scale-[0.97] opacity-0',
        )}
      >
        {/* Header: provenance strip */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-subtle bg-surface-overlay px-3.5 py-2.5 sm:px-5">
          {auto ? (
            <Badge variant="protected">auto-sent</Badge>
          ) : (
            <Badge variant={isCleanup ? 'review' : 'info'}>{isCleanup ? 'Cleanup' : 'Email'}</Badge>
          )}
          {queueItem && <StateBadge state={queueItem.state} />}
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-tertiary">
            <AgentAvatar
              agentKey={agent?.key ?? agentKey}
              avatarUrl={agent?.avatar_url}
              size={18}
              className="ring-1 ring-border"
            />
            <span className="truncate font-mono">{agentLabel(agentKey)}</span>
            {agent && (
              <span className="hidden rounded-md bg-warning/[0.14] px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.04em] text-warning sm:inline">
                {AUTONOMY_SHORT[agent.autonomy_level]}
              </span>
            )}
          </span>
          {headerTime && (
            <span className="font-mono text-[10.5px] text-muted">{formatWhen(headerTime)}</span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {threadId && (
              <button
                type="button"
                onClick={openThread}
                title="Open this conversation in Mail"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-tertiary transition-colors hover:bg-accent/12 hover:text-accent"
              >
                <PopOutIcon className="h-[14px] w-[14px]" />
                <span className="hidden sm:inline">Open thread</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="Close"
              aria-label="Close"
              className="grid h-8 w-8 place-items-center rounded-lg text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary"
            >
              <CloseIcon className="h-[15px] w-[15px]" />
            </button>
          </span>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5 sm:p-5">
          <div className="space-y-3.5">
            <h2 className="text-lg font-semibold leading-snug tracking-[-0.01em] text-primary">
              {displaySubject}
            </h2>

            {auto && auto.detail && (
              <p className="text-xs leading-5 text-tertiary">{auto.detail}</p>
            )}

            {policy && <HoldBanner policy={policy} pending={pending} />}

            {isCleanup && queueItem ? (
              <CleanupAffectedList item={queueItem} />
            ) : (
              <>
                {/* Recipient rows — the full envelope, like a draft's header block */}
                <div className="space-y-1.5 rounded-token border border-subtle bg-surface-base/40 p-3">
                  <AddressRow
                    label="From"
                    values={
                      message?.from_address
                        ? [message.from_address]
                        : agent?.mailbox_address
                          ? [agent.mailbox_address]
                          : []
                    }
                  />
                  <AddressRow label="To" values={message?.to_addresses ?? []} />
                  <AddressRow label="Cc" values={message?.cc_addresses ?? []} />
                  {!message?.from_address &&
                    !agent?.mailbox_address &&
                    (message?.to_addresses.length ?? 0) === 0 && (
                      <p className="text-xs italic text-muted">No recipients recorded.</p>
                    )}
                </div>

                {/* The rendered email — exactly what the recipient will see */}
                {message?.html_body ? (
                  <HtmlEmailBody
                    html={message.html_body}
                    senderAddress={message.from_address ? bareAddress(message.from_address) : null}
                    attachments={downloadableMail}
                    resolveCidUrl={resolveCid}
                  />
                ) : message?.text_body ? (
                  <div className="w-full max-w-[680px]">
                    <p className="whitespace-pre-wrap text-sm leading-6 text-secondary">
                      {message.text_body}
                    </p>
                  </div>
                ) : queueItem?.body_preview ? (
                  <div className="w-full max-w-[680px]">
                    <p className="whitespace-pre-wrap text-sm leading-6 text-secondary">
                      {queueItem.body_preview}
                    </p>
                  </div>
                ) : detailLoad === 'loading' ? (
                  <p className="text-xs text-muted">Loading the full draft…</p>
                ) : (
                  <p className="text-xs italic text-muted">No body captured for this message.</p>
                )}

                {/* Honesty note when the full body isn't available */}
                {!hasFullBody && detailLoad !== 'loading' && !auto && (
                  <p className="rounded-token border border-subtle bg-surface-base/50 px-2.5 py-1.5 text-[11px] leading-5 text-tertiary">
                    {detailLoad === 'absent'
                      ? 'This server doesn’t expose the full staged draft yet — you’re seeing the queue summary. The exact rendered body arrives with the Wave-7 backend.'
                      : detailLoad === 'error'
                        ? 'Could not load the full draft — showing the queue summary instead.'
                        : 'Showing the staged summary for this message.'}
                  </p>
                )}

                {/* Attachments */}
                {attachments.length > 0 && (
                  <section>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
                      Attachments ({attachments.length})
                    </p>
                    {workspaceId && blobMailboxId && downloadableMail.length > 0 && (
                      <MessageAttachments
                        attachments={downloadableMail}
                        workspaceId={workspaceId}
                        mailboxId={blobMailboxId}
                      />
                    )}
                    {metaOnly.length > 0 && (
                      <div className="mt-2">
                        <StagedAttachmentChips items={metaOnly} />
                      </div>
                    )}
                  </section>
                )}
              </>
            )}

            {/* Decided items: the audit line */}
            {queueItem && queueItem.state !== 'pending' && (
              <p className="border-t border-subtle pt-3 text-[11.5px] leading-5 text-muted">
                {queueItem.state === 'approved' ? 'Approved' : 'Rejected'}
                {queueItem.reviewed_by_uc_uid ? ` by ${queueItem.reviewed_by_uc_uid}` : ''}
                {queueItem.reviewed_at ? ` · ${formatWhen(queueItem.reviewed_at) ?? ''}` : ''}
                {queueItem.review_note ? ` · “${queueItem.review_note}”` : ''}
              </p>
            )}

            {/* Auto-sent: per-recipient trust controls */}
            {auto && recipients.length > 0 && (
              <section className="border-t border-subtle pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
                  Trust controls
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {recipients.map((addr) => {
                    const bare = bareAddress(addr);
                    const row = trusted?.find(bare) ?? null;
                    return (
                      <li key={bare} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-xs text-secondary">
                          {bare}
                        </span>
                        {row ? (
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={revokeBusy !== null}
                            onClick={() => void handleRevoke(bare)}
                          >
                            {revokeBusy === bare ? 'Revoking…' : 'Revoke trust'}
                          </Button>
                        ) : (
                          <span className="shrink-0 text-[10.5px] text-muted">
                            {trusted && trusted.load === 'absent'
                              ? 'trust list unavailable'
                              : trusted && trusted.load === 'ready'
                                ? 'not on the trusted list'
                                : '…'}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {revokeNote && <p className="mt-1.5 text-[11px] text-tertiary">{revokeNote}</p>}
              </section>
            )}
          </div>
        </div>

        {/* Footer: the decision controls (pending queue items only) */}
        {pending && (onApprove || onReject) && (
          <div className="shrink-0 space-y-2.5 border-t border-subtle bg-surface-overlay/70 p-3 sm:px-5 sm:py-3.5">
            {trustAddresses.length > 0 && (
              <label className="flex cursor-pointer items-start gap-2 text-[12px] leading-5 text-secondary">
                <input
                  type="checkbox"
                  checked={trustChoice}
                  onChange={(e) => setTrustChoice(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[rgb(var(--accent))]"
                />
                <span title="Approving with this checked lets routine agent replies to this correspondent send without approval next time. Revocable any time under Trusted senders.">
                  Trust{' '}
                  <span className="font-mono text-[11.5px] text-primary">
                    {trustAddresses.join(', ')}
                  </span>{' '}
                  for future auto-replies
                  {' · '}
                  <a
                    href="/help#autonomy-trust"
                    className="text-accent underline decoration-dotted underline-offset-2 hover:opacity-80"
                  >
                    how trust works
                  </a>
                </span>
              </label>
            )}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              placeholder="Review note (optional — kept on the audit record)"
              className="block w-full rounded-token border border-subtle bg-surface-raised px-3 py-2 text-sm text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <div className="flex flex-wrap items-center gap-2">
              {onApprove && (
                <Button size="sm" disabled={acting !== null} onClick={() => void handleApprove()}>
                  {acting === 'approve'
                    ? isCleanup
                      ? 'Running…'
                      : 'Sending…'
                    : approveVerb}
                </Button>
              )}
              {onReject && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={acting !== null}
                  onClick={() => void handleReject()}
                >
                  {acting === 'reject' ? 'Rejecting…' : 'Reject'}
                </Button>
              )}
              {actionError && <span className="text-xs text-danger">{actionError}</span>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
