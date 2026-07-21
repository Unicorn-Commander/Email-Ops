'use client';

/**
 * Top-level "Compose" dialog — a new message from the selected mailbox.
 *
 * Wave 2: To/Cc/Bcc are token-chip inputs (Cc/Bcc behind a "Cc Bcc" toggle),
 * with attachment upload via file picker or drag-drop (progress chips, blob
 * refs included in the compose). Forward opens this dialog prefilled with
 * "Fwd:", the quoted original, and the original's attachments as already-
 * uploaded blob refs.
 *
 * On success it shows the TRUTHFUL backend status inline (the engine may be
 * dormant → "Recorded — will send once the engine is live") and only auto-closes
 * when the message genuinely sent; otherwise it keeps the dialog open with the
 * status so the user sees what happened to what they wrote.
 *
 * It accepts an optional `initial` prefill so an agent's `ui_compose` (Phase C)
 * can open the composer already populated — the user still reviews and sends it.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Button, Dialog, Input, cn } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import {
  createMailDraft,
  listMailSignatures,
  updateMailDraft,
  type ComposeBody,
  type MailSignature,
  type UploadedBlob,
} from '@/lib/mailApi';
import { formatScheduleWhen, schedulePresets, toDatetimeLocalValue } from '@/lib/scheduleTime';
import type { ComposeOutcome } from './useMailClient';
import { ComposeStatusLine, describeStatus } from './ComposeStatus';
import { RecipientChips, isValidEmail } from './RecipientChips';
import { AttachButton, ComposerAttachments, useAttachmentUploads } from './AttachmentList';
import { RichTextEditor, htmlToText } from './RichTextEditor';

/** Prefill for the dialog (agent `ui_compose`, or Forward with attachments). */
export interface ComposeDialogPrefill {
  to?: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  bodyHtml?: string;
  draftId?: string | null;
  /** Already-uploaded blobs to carry (Forward keeps the original's attachments). */
  attachments?: UploadedBlob[];
}

function toList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : v.trim() ? [v.trim()] : [];
}

function signatureBlock(sig: MailSignature): string {
  return sig.html.trim() ? `<p>-- </p>${sig.html}` : '';
}

function plainToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((part) =>
      `<p>${part
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

export function ComposeDialog({
  open,
  onClose,
  fromAddress,
  workspaceId,
  mailboxId,
  onCompose,
  onScheduleSend,
  canSchedule,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  /** The address the message is sent from (the selected mailbox), for context. */
  fromAddress: string | null;
  /** Workspace + mailbox the attachments upload into (null disables uploads). */
  workspaceId: string | null;
  mailboxId: string | null;
  onCompose: (
    body: Pick<
      ComposeBody,
      'to_address' | 'subject' | 'body' | 'body_html' | 'cc' | 'bcc' | 'attachments' | 'draft_id'
    >,
  ) => Promise<ComposeOutcome>;
  /**
   * Optional "Send later": schedule the composed message to leave at `sendAt`.
   * Only offered when `canSchedule` is true (a sovereign mailbox with the
   * scheduling endpoint live); absent → the composer sends immediately only.
   */
  onScheduleSend?: (
    body: Pick<
      ComposeBody,
      'to_address' | 'subject' | 'body' | 'body_html' | 'cc' | 'bcc' | 'attachments' | 'draft_id'
    >,
    sendAt: Date,
  ) => Promise<{ ok: boolean; error?: string }>;
  canSchedule?: boolean;
  /**
   * Optional prefill (e.g. an agent's `ui_compose`, or Forward). Seeds the
   * fields each time the dialog opens; null/undefined opens it blank.
   */
  initial?: ComposeDialogPrefill | null;
}) {
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [signatures, setSignatures] = useState<MailSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string>('none');
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmExternal, setConfirmExternal] = useState(false);

  const uploads = useAttachmentUploads(workspaceId, mailboxId);
  const { reset: resetUploads } = uploads;
  const appliedSignature = useRef<string>('');
  const saveTimer = useRef<number | null>(null);
  const lastSavedSnapshot = useRef<string>('');

  // Seed the fields when the dialog re-opens. An explicit prefill (Forward /
  // agent `ui_compose`) wins.
  useEffect(() => {
    if (!open) return;
    const seededBody = initial?.bodyHtml ?? (initial?.body ? plainToHtml(initial.body) : '');
    setTo(toList(initial?.to));
    setCc(initial?.cc ?? []);
    setBcc(initial?.bcc ?? []);
    setShowCcBcc((initial?.cc?.length ?? 0) > 0 || (initial?.bcc?.length ?? 0) > 0);
    setSubject(initial?.subject ?? '');
    setBody(seededBody);
    setDraftId(initial?.draftId ?? null);
    setStatus(null);
    setError(null);
    setSending(false);
    setDragging(false);
    setDraftSavedAt(null);
    setDraftSaving(false);
    setSignatures([]);
    setSelectedSignatureId('none');
    setSignatureError(null);
    setConfirmEmpty(false);
    setConfirmExternal(false);
    appliedSignature.current = '';
    lastSavedSnapshot.current = JSON.stringify({
      to: toList(initial?.to),
      cc: initial?.cc ?? [],
      bcc: initial?.bcc ?? [],
      subject: initial?.subject ?? '',
      body: seededBody,
      attachments: initial?.attachments ?? [],
      draftId: initial?.draftId ?? null,
    });
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    resetUploads(initial?.attachments);
  }, [open, initial, resetUploads]);

  useEffect(() => {
    if (!open || !workspaceId || !mailboxId) return;
    let alive = true;
    void (async () => {
      try {
        const res = await listMailSignatures(workspaceId, mailboxId);
        if (!alive) return;
        setSignatures(res.items);
        const def = res.items.find((s) => s.is_default);
        if (def) {
          setSelectedSignatureId(def.id);
          const block = signatureBlock(def);
          appliedSignature.current = block;
          setBody((current) => (block && !current.endsWith(block) ? `${current}${block}` : current));
        }
      } catch {
        if (alive) setSignatureError('Could not load signatures.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, workspaceId, mailboxId]);

  function applySignature(nextId: string) {
    setSelectedSignatureId(nextId);
    const next = signatures.find((s) => s.id === nextId);
    const nextBlock = next ? signatureBlock(next) : '';
    setBody((current) => {
      const prior = appliedSignature.current;
      const base = prior && current.endsWith(prior) ? current.slice(0, -prior.length).replace(/\s+$/, '') : current;
      appliedSignature.current = nextBlock;
      return nextBlock ? `${base}${nextBlock}` : base;
    });
  }

  function buildSnapshot(): string {
    return JSON.stringify({
      to,
      cc,
      bcc,
      subject,
      body,
      attachments: uploads.refs(),
      draftId,
    });
  }

  function hasDraftContent(): boolean {
    return to.length > 0;
  }

  async function persistDraft(): Promise<{ draft_id: string | null; updated: boolean } | null> {
    if (!open || !workspaceId || !mailboxId || sending || draftSaving || !hasDraftContent()) return null;
    const attachments = uploads.refs();
    const payload = {
      to_address: to.join(', '),
      subject: subject.trim() || undefined,
      body: htmlToText(body) || undefined,
      body_html: body.trim() || undefined,
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(draftId ? { draft_id: draftId } : {}),
    };
    setDraftSaving(true);
    try {
      const result = draftId
        ? await updateMailDraft(workspaceId, mailboxId, draftId, payload)
        : await createMailDraft(workspaceId, mailboxId, payload);
      const savedDraftId = result.draft_id ?? draftId;
      if (result.draft_id && result.draft_id !== draftId) setDraftId(result.draft_id);
      setDraftSavedAt(new Date().toISOString());
      lastSavedSnapshot.current = JSON.stringify({
        to,
        cc,
        bcc,
        subject,
        body,
        attachments,
        draftId: savedDraftId,
      });
      return result;
    } catch {
      return null;
    } finally {
      setDraftSaving(false);
    }
  }

  // Debounced autosave while the dialog is open. The first render after a seed
  // does not force a save; we only persist when the user has actually changed
  // the snapshot.
  useEffect(() => {
    if (!open) return;
    const snapshot = buildSnapshot();
    if (snapshot === lastSavedSnapshot.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void persistDraft();
    }, 2000);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [open, to, cc, bcc, subject, body, draftId, workspaceId, mailboxId, sending, draftSaving, uploads.items]);

  useEffect(() => {
    if (!draftSavedAt) return;
    const t = window.setTimeout(() => setDraftSavedAt(null), 4000);
    return () => window.clearTimeout(t);
  }, [draftSavedAt]);

  useEffect(() => {
    setConfirmEmpty(false);
    setConfirmExternal(false);
  }, [subject, body, canSchedule]);

  const allRecipients = [...to, ...cc, ...bcc];
  const invalidCount = allRecipients.filter((a) => !isValidEmail(a)).length;
  const canSend = to.length > 0 && invalidCount === 0 && !sending && !uploads.uploading;
  const noSubject = subject.trim() === '';
  const noBody = htmlToText(body).trim() === '';

  async function saveAndClose() {
    await persistDraft();
    onClose();
  }

  function handleOpenChange(next: boolean) {
    if (next || sending) return;
    void saveAndClose();
  }

  function buildComposeBody() {
    const attachments = uploads.refs();
    return {
      to_address: to.join(', '),
      subject: subject.trim() || undefined,
      body: htmlToText(body) || undefined,
      body_html: body.trim() || undefined,
      ...(draftId ? { draft_id: draftId } : {}),
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  function clearDraftState() {
    setDraftId(null);
    setDraftSavedAt(null);
    lastSavedSnapshot.current = '';
  }

  async function handleSend() {
    if (!canSend) return;
    if ((noSubject || noBody) && !confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    if (!canSchedule && !confirmExternal) {
      setConfirmExternal(true);
      return;
    }
    setConfirmEmpty(false);
    setConfirmExternal(false);
    setSending(true);
    setError(null);
    setStatus(null);
    const res = await onCompose(buildComposeBody());
    setSending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not record the message.');
      return;
    }
    const meta = describeStatus(res.message?.status);
    setStatus(res.message?.status ?? null);
    // A messageless ok = the undo-send lane accepted it (the message is a
    // scheduled send in its undo window; the UndoSendBar takes over from here).
    // The immediate lane always carries the recorded message projection.
    if (meta.sent || !res.message) {
      clearDraftState();
      onClose();
    }
  }

  async function handleSchedule(sendAt: Date) {
    if (!canSend || !onScheduleSend) return;
    if ((noSubject || noBody) && !confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setConfirmEmpty(false);
    if (!Number.isFinite(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
      setError('Pick a time in the future.');
      return;
    }
    setSending(true);
    setError(null);
    setStatus(null);
    const res = await onScheduleSend(buildComposeBody(), sendAt);
    setSending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not schedule the message.');
      return;
    }
    // Queued to send later — treat like a successful send: drop the draft + close.
    clearDraftState();
    onClose();
  }

  function handleDrop(e: DragEvent<HTMLFormElement>) {
    e.preventDefault();
    setDragging(false);
    if (uploads.supported && e.dataTransfer.files.length > 0) {
      uploads.addFiles(e.dataTransfer.files);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="New message"
      className="max-w-xl"
      description={
        fromAddress ? (
          <>
            From <span className="font-mono text-secondary">{fromAddress}</span>
          </>
        ) : (
          'Compose a new message.'
        )
      }
      footer={
        <>
          {uploads.supported && (
            <AttachButton
              onFiles={uploads.addFiles}
              disabled={sending || !mailboxId}
              className="mr-auto"
            />
          )}
          <span
            aria-live="polite"
            className={cn(
              'mr-1 flex items-center gap-1 text-[11px] text-tertiary transition-opacity duration-token ease-token',
              draftSavedAt ? 'opacity-100' : 'opacity-0',
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
            {draftSavedAt
              ? `Saved · ${new Date(draftSavedAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
              : 'Saved'}
          </span>
          <Tooltip content="Keep this as a draft (it autosaves anyway) and close the composer">
            <Button variant="secondary" size="sm" disabled={sending} onClick={() => void saveAndClose()}>
              Save draft & close
            </Button>
          </Tooltip>
          {canSchedule && onScheduleSend && (
            <SendLaterMenu disabled={!canSend} onPick={(at) => void handleSchedule(at)} />
          )}
          <Tooltip content="⌘+Enter sends from anywhere in the composer">
            <kbd className="hidden min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-surface-overlay px-1.5 py-px text-[11px] leading-none text-secondary sm:inline-flex mono">
              ⌘↵
            </kbd>
          </Tooltip>
          {confirmExternal ? (
            <span className="mr-1 text-xs text-warning">Send now? External sends can&apos;t be undone.</span>
          ) : confirmEmpty ? (
            <span className="mr-1 text-xs text-warning">
              {noSubject && noBody
                ? 'This email has no subject or body.'
                : noSubject
                  ? 'This email has no subject.'
                  : 'This email has no message body.'}
            </span>
          ) : null}
          <Button size="sm" disabled={!canSend} onClick={() => void handleSend()}>
            {sending
              ? 'Sending…'
              : uploads.uploading
                ? 'Uploading…'
                : confirmExternal
                  ? 'Send anyway'
                  : confirmEmpty
                    ? 'Send anyway'
                    : 'Send'}
          </Button>
        </>
      }
    >
      <form
        className={cn(
          'space-y-4 rounded-token transition-colors duration-fast ease-token',
          dragging && 'bg-accent/5 ring-2 ring-accent/40',
        )}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            void persistDraft();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
        onDragOver={(e) => {
          if (uploads.supported) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="block text-[11px] font-medium text-tertiary">To</span>
            {!showCcBcc && (
              <Tooltip content="Add Cc (visible copy) and Bcc (hidden copy) recipient fields">
                <button
                  type="button"
                  onClick={() => setShowCcBcc(true)}
                  className="rounded-token px-1.5 py-0.5 text-[11px] font-medium text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay/60 hover:text-primary"
                >
                  Cc Bcc
                </button>
              </Tooltip>
            )}
          </div>
          <RecipientChips
            value={to}
            onChange={setTo}
            autoFocus
            aria-label="To"
            workspaceId={workspaceId}
            mailboxId={mailboxId}
          />
        </div>

        {showCcBcc && (
          <>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Cc</span>
              <RecipientChips
                value={cc}
                onChange={setCc}
                placeholder=""
                aria-label="Cc"
                workspaceId={workspaceId}
                mailboxId={mailboxId}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Bcc</span>
              <RecipientChips
                value={bcc}
                onChange={setBcc}
                placeholder=""
                aria-label="Bcc"
                workspaceId={workspaceId}
                mailboxId={mailboxId}
              />
            </label>
          </>
        )}

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-tertiary">Subject</span>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-tertiary">Message</span>
          <RichTextEditor
            value={body}
            onChange={setBody}
            disabled={sending}
            placeholder="Write your message…  (drop files here to attach)"
          />
        </label>

        {(signatures.length > 0 || signatureError) && (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-tertiary">Signature</span>
            <select
              value={selectedSignatureId}
              onChange={(e) => applySignature(e.target.value)}
              className="block w-full rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="none">No signature</option>
              {signatures.map((sig) => (
                <option key={sig.id} value={sig.id}>
                  {sig.name}
                  {sig.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
            {signatureError && <p className="mt-1 text-xs text-danger">{signatureError}</p>}
          </label>
        )}

        <ComposerAttachments items={uploads.items} onRemove={uploads.remove} disabled={sending} />

        {invalidCount > 0 ? (
          <p className="text-xs text-danger">
            {invalidCount === 1 ? 'One recipient looks invalid.' : `${invalidCount} recipients look invalid.`}{' '}
            Fix or remove the red chips to send.
          </p>
        ) : error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : status ? (
          <ComposeStatusLine status={status} />
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * "Send later" split control — presets (shared with snooze) plus a custom
 * datetime picker. Drops UPWARD (it lives in the dialog footer). Closes on
 * pick / outside-click / Escape. Purely presentational: it hands a chosen Date
 * back to the composer, which validates + schedules.
 */
function SendLaterMenu({ disabled, onPick }: { disabled?: boolean; onPick: (at: Date) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); // back to the trigger
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    // Land keyboard focus on the first option, matching the reader's SnoozeControl.
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const presets = useMemo(() => (open ? schedulePresets() : []), [open]);
  // Custom picker floor: ~5 minutes out, so the value is meaningfully in the future.
  const minLocal = useMemo(() => toDatetimeLocalValue(new Date(Date.now() + 5 * 60 * 1000)), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickCustom() {
    if (!custom) return;
    // datetime-local has no timezone → parsed as LOCAL wall-clock, which is what
    // the user meant; the composer converts to ISO/UTC for the API.
    const at = new Date(custom);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) return;
    setOpen(false);
    onPick(at);
  }

  return (
    <div ref={ref} className="relative">
      <Tooltip content="Queue this message to leave at a time you pick — cancel it from the Scheduled view">
        <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setOpen((v) => !v)}>
          Send later
        </Button>
      </Tooltip>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Send later"
          className="absolute bottom-full right-0 z-30 mb-1 w-64 rounded-lg border border-subtle bg-surface-overlay p-1 shadow-xl"
        >
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
            Send later
          </p>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(p.at);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-secondary transition-colors hover:bg-surface-elevated hover:text-primary focus:bg-surface-elevated focus:text-primary focus:outline-none"
            >
              <span>{p.label}</span>
              <span className="mono text-[11px] text-muted">{formatScheduleWhen(p.at)}</span>
            </button>
          ))}
          <div className="mt-1 border-t border-subtle px-2 pb-1 pt-2">
            <label className="mb-1 block text-[11px] font-medium text-tertiary">Pick a time</label>
            <div className="flex items-center gap-1.5">
              <input
                type="datetime-local"
                value={custom}
                min={minLocal}
                onChange={(e) => setCustom(e.target.value)}
                className="min-w-0 flex-1 rounded-token border border-border bg-surface-base px-2 py-1 text-[12px] text-primary focus:border-accent focus:outline-none"
              />
              <Button size="sm" disabled={!custom} onClick={pickCustom}>
                Set
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
