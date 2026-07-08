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

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Button, Dialog, Input, cn } from '@/components/ui';
import { listMailSignatures, type ComposeBody, type MailSignature, type UploadedBlob } from '@/lib/mailApi';
import type { ComposeOutcome } from './useMailClient';
import { ComposeStatusLine, describeStatus } from './ComposeStatus';
import { RecipientChips, isValidEmail } from './RecipientChips';
import { AttachButton, ComposerAttachments, useAttachmentUploads } from './AttachmentList';

/** Prefill for the dialog (agent `ui_compose`, or Forward with attachments). */
export interface ComposeDialogPrefill {
  to?: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  /** Already-uploaded blobs to carry (Forward keeps the original's attachments). */
  attachments?: UploadedBlob[];
}

function toList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : v.trim() ? [v.trim()] : [];
}

function signatureText(html: string): string {
  if (typeof window === 'undefined') return html.replace(/<[^>]*>/g, '').trim();
  const el = window.document.createElement('div');
  el.innerHTML = html;
  return (el.textContent || el.innerText || '').trim();
}

function signatureBlock(sig: MailSignature): string {
  const text = signatureText(sig.html);
  return text ? `\n\n-- \n${text}` : '';
}

/** Stable key for the new-message draft body. */
const COMPOSE_DRAFT_KEY = 'emailops:draft:compose:new';

/**
 * Draft persistence helpers — SSR- and private-mode-safe (guard `window`, swallow
 * QuotaExceeded/SecurityError).
 */
function readDraft(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeDraft(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function clearDraft(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* private mode / unavailable — nothing to clean up */
  }
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
    body: Pick<ComposeBody, 'to_address' | 'subject' | 'body' | 'cc' | 'bcc' | 'attachments'>,
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
  const [draftSaved, setDraftSaved] = useState(false);
  const [signatures, setSignatures] = useState<MailSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string>('none');
  const [signatureError, setSignatureError] = useState<string | null>(null);

  const uploads = useAttachmentUploads(workspaceId, mailboxId);
  const { reset: resetUploads } = uploads;
  const appliedSignature = useRef<string>('');

  // Skips the autosave run caused by the seed effect below, so re-opening the
  // dialog doesn't immediately flash "Saved".
  const skipNextAutosave = useRef(false);

  // Seed the fields when the dialog re-opens. An explicit prefill (Forward /
  // agent `ui_compose`) wins; otherwise hydrate the body from the saved draft.
  useEffect(() => {
    if (open) {
      setTo(toList(initial?.to));
      setCc(initial?.cc ?? []);
      setBcc(initial?.bcc ?? []);
      setShowCcBcc((initial?.cc?.length ?? 0) > 0 || (initial?.bcc?.length ?? 0) > 0);
      setSubject(initial?.subject ?? '');
      setBody(initial?.body ?? readDraft(COMPOSE_DRAFT_KEY) ?? '');
      setStatus(null);
      setError(null);
      setSending(false);
      setDragging(false);
      setDraftSaved(false);
      setSignatures([]);
      setSelectedSignatureId('none');
      setSignatureError(null);
      appliedSignature.current = '';
      skipNextAutosave.current = true;
      resetUploads(initial?.attachments);
    }
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

  // Debounced autosave of the body while the dialog is open. Never persists a
  // whitespace-only draft (clears the key instead).
  useEffect(() => {
    if (!open) return;
    if (skipNextAutosave.current) {
      skipNextAutosave.current = false;
      return;
    }
    const t = setTimeout(() => {
      if (body.trim().length === 0) {
        clearDraft(COMPOSE_DRAFT_KEY);
        setDraftSaved(false);
      } else if (writeDraft(COMPOSE_DRAFT_KEY, body)) {
        setDraftSaved(true);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [open, body]);

  // Fade the "Saved" pill back out shortly after it appears.
  useEffect(() => {
    if (!draftSaved) return;
    const t = setTimeout(() => setDraftSaved(false), 1600);
    return () => clearTimeout(t);
  }, [draftSaved]);

  const allRecipients = [...to, ...cc, ...bcc];
  const invalidCount = allRecipients.filter((a) => !isValidEmail(a)).length;
  const canSend = to.length > 0 && invalidCount === 0 && !sending && !uploads.uploading;

  function handleOpenChange(next: boolean) {
    if (!next && !sending) onClose();
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
      body: body.trim() || undefined,
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
    // Only close on a genuine send; otherwise hold so the truthful status shows.
    if (meta.sent) {
      clearDraft(COMPOSE_DRAFT_KEY);
      setDraftSaved(false);
      onClose();
    }
  }

  function handleBodyKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // ⌘/Ctrl + Enter submits directly (guards live inside handleSend).
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
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
              draftSaved ? 'opacity-100' : 'opacity-0',
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
            Draft saved
          </span>
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => handleOpenChange(false)}>
            {status ? 'Close' : 'Cancel'}
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
          <RecipientChips value={to} onChange={setTo} autoFocus aria-label="To" />
        </div>

        {showCcBcc && (
          <>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Cc</span>
              <RecipientChips value={cc} onChange={setCc} placeholder="" aria-label="Cc" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Bcc</span>
              <RecipientChips value={bcc} onChange={setBcc} placeholder="" aria-label="Bcc" />
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
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleBodyKeyDown}
            rows={6}
            placeholder="Write your message…  (drop files here to attach)"
            className="block w-full resize-y rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
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
