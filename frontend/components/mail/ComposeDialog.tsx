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

import { useEffect, useState, type DragEvent } from 'react';
import { Button, Dialog, Input, cn } from '@/components/ui';
import type { ComposeBody, UploadedBlob } from '@/lib/mailApi';
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

  const uploads = useAttachmentUploads(workspaceId, mailboxId);
  const { reset: resetUploads } = uploads;

  // Seed (or clear) the fields from `initial` when the dialog re-opens.
  useEffect(() => {
    if (open) {
      setTo(toList(initial?.to));
      setCc(initial?.cc ?? []);
      setBcc(initial?.bcc ?? []);
      setShowCcBcc((initial?.cc?.length ?? 0) > 0 || (initial?.bcc?.length ?? 0) > 0);
      setSubject(initial?.subject ?? '');
      setBody(initial?.body ?? '');
      setStatus(null);
      setError(null);
      setSending(false);
      setDragging(false);
      resetUploads(initial?.attachments);
    }
  }, [open, initial, resetUploads]);

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
    if (meta.sent) onClose();
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
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => handleOpenChange(false)}>
            {status ? 'Close' : 'Cancel'}
          </Button>
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
            rows={6}
            placeholder="Write your message…  (drop files here to attach)"
            className="block w-full resize-y rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </label>

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
