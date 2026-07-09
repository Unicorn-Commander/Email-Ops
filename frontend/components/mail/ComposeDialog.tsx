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

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Button, Dialog, Input, cn } from '@/components/ui';
import {
  createMailDraft,
  listMailSignatures,
  updateMailDraft,
  type ComposeBody,
  type MailSignature,
  type UploadedBlob,
} from '@/lib/mailApi';
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

  const allRecipients = [...to, ...cc, ...bcc];
  const invalidCount = allRecipients.filter((a) => !isValidEmail(a)).length;
  const canSend = to.length > 0 && invalidCount === 0 && !sending && !uploads.uploading;

  async function saveAndClose() {
    await persistDraft();
    onClose();
  }

  function handleOpenChange(next: boolean) {
    if (next || sending) return;
    void saveAndClose();
  }

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    setStatus(null);
    const attachments = uploads.refs();
    const res = await onCompose({
      to_address: to.join(', '),
      subject: subject.trim() || undefined,
      body: htmlToText(body) || undefined,
      body_html: body.trim() || undefined,
      ...(draftId ? { draft_id: draftId } : {}),
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    setSending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not record the message.');
      return;
    }
    const meta = describeStatus(res.message?.status);
    setStatus(res.message?.status ?? null);
    if (meta.sent) {
      setDraftId(null);
      setDraftSavedAt(null);
      lastSavedSnapshot.current = '';
      onClose();
    }
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
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => void saveAndClose()}>
            Save draft & close
          </Button>
          <kbd className="hidden min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-surface-overlay px-1.5 py-px text-[11px] leading-none text-secondary sm:inline-flex mono">
            ⌘↵
          </kbd>
          <Button size="sm" disabled={!canSend} onClick={() => void handleSend()}>
            {sending ? 'Sending…' : uploads.uploading ? 'Uploading…' : 'Send'}
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
              <button
                type="button"
                onClick={() => setShowCcBcc(true)}
                className="rounded-token px-1.5 py-0.5 text-[11px] font-medium text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay/60 hover:text-primary"
              >
                Cc Bcc
              </button>
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
