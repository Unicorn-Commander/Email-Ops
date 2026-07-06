'use client';

/**
 * Inline reply composer for the open thread (right pane of the mail client).
 *
 * Wave 2: To/Cc token-chip recipients (Cc behind a toggle), attachment upload
 * (picker + drag-drop, progress chips), and reply-all seeding — the page
 * remounts this (via `key`) with new defaults when the user picks Reply or
 * Reply-all on a message.
 *
 * Posts through the hook's `reply` (which threads it with
 * `in_reply_to_thread_id`) and then surfaces the TRUTHFUL backend status: when
 * the mail engine is dormant a reply comes back `status: 'failed'` — recorded,
 * not sent — so we say exactly that rather than flashing a misleading "Sent".
 */

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { Button, Input, cn } from '@/components/ui';
import type { ComposeBody } from '@/lib/mailApi';
import type { ComposeOutcome } from './useMailClient';
import { ComposeStatusLine, describeStatus } from './ComposeStatus';
import { RecipientChips, isValidEmail } from './RecipientChips';
import { AttachButton, ComposerAttachments, useAttachmentUploads } from './AttachmentList';
import { ReplyIcon, CloseIcon } from './icons';

export interface ReplyComposerHandle {
  /** Focus the reply body (the `r` shortcut). */
  focus: () => void;
}

export const ReplyComposer = forwardRef<
  ReplyComposerHandle,
  {
    defaultTo: string[];
    defaultCc?: string[];
    defaultSubject: string;
    /** Workspace + mailbox attachments upload into (null disables uploads). */
    workspaceId: string | null;
    mailboxId: string | null;
    /** RFC threading hint: the id of the message being replied to. */
    inReplyTo?: string | null;
    /** Sends the reply; the page wires this to the hook's `reply`. */
    onSend: (
      body: Pick<
        ComposeBody,
        'to_address' | 'subject' | 'body' | 'cc' | 'attachments' | 'in_reply_to'
      >,
    ) => Promise<ComposeOutcome>;
    /** Collapse the composer back to the compact reply action bar. */
    onCollapse?: () => void;
  }
>(function ReplyComposer(
  { defaultTo, defaultCc, defaultSubject, workspaceId, mailboxId, inReplyTo, onSend, onCollapse },
  ref,
) {
  const [to, setTo] = useState<string[]>(defaultTo.filter(Boolean));
  const [cc, setCc] = useState<string[]>(defaultCc ?? []);
  const [showCc, setShowCc] = useState((defaultCc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => bodyRef.current?.focus() }), []);

  const uploads = useAttachmentUploads(workspaceId, mailboxId);

  const invalidCount = [...to, ...cc].filter((a) => !isValidEmail(a)).length;
  const canSend =
    to.length > 0 && invalidCount === 0 && body.trim().length > 0 && !sending && !uploads.uploading;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    setStatus(null);
    const attachments = uploads.refs();
    const res = await onSend({
      to_address: to.join(', '),
      subject: subject.trim() || undefined,
      body: body.trim() || undefined,
      ...(cc.length > 0 ? { cc } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
    });
    setSending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not record your reply.');
      return;
    }
    // Truthful status. If it actually sent, clear the draft; otherwise keep it
    // visible so nothing the user wrote is silently lost.
    setStatus(res.message?.status ?? null);
    if (describeStatus(res.message?.status).sent) {
      setBody('');
      uploads.reset();
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (uploads.supported && e.dataTransfer.files.length > 0) {
      uploads.addFiles(e.dataTransfer.files);
    }
  }

  return (
    <div
      className={cn(
        'rounded-token-lg border border-subtle bg-surface-raised/50 p-3.5 shadow-token transition-colors duration-fast ease-token',
        dragging && 'bg-accent/5 ring-2 ring-inset ring-accent/40',
      )}
      onDragOver={(e) => {
        if (uploads.supported) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <ReplyIcon className="h-3.5 w-3.5 text-accent" />
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-tertiary">
          Reply
        </span>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Close reply"
            title="Close reply"
            className="grid h-6 w-6 place-items-center rounded-md text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary"
          >
            <CloseIcon className="h-[14px] w-[14px]" />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="block min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-between">
              <span className="block text-[11px] font-medium text-tertiary">To</span>
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="rounded-token px-1.5 py-0.5 text-[11px] font-medium text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay/60 hover:text-primary"
                >
                  Cc
                </button>
              )}
            </div>
            <RecipientChips value={to} onChange={setTo} aria-label="To" />
          </div>
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block text-[11px] font-medium text-tertiary">Subject</span>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Re: …"
              autoComplete="off"
            />
          </label>
        </div>

        {showCc && (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-tertiary">Cc</span>
            <RecipientChips value={cc} onChange={setCc} placeholder="" aria-label="Cc" />
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-tertiary">Message</span>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Write a reply…  (drop files here to attach)"
            className="block w-full resize-y rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </label>

        <ComposerAttachments items={uploads.items} onRemove={uploads.remove} disabled={sending} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {uploads.supported && (
              <AttachButton onFiles={uploads.addFiles} disabled={sending || !mailboxId} />
            )}
            {invalidCount > 0 ? (
              <p className="text-xs text-danger">Fix or remove the red recipient chips to send.</p>
            ) : error ? (
              <p className="text-xs text-danger">{error}</p>
            ) : status ? (
              <ComposeStatusLine status={status} />
            ) : (
              <p className="text-[11px] text-muted">Replies thread into this conversation.</p>
            )}
          </div>
          <Button size="sm" disabled={!canSend} onClick={() => void handleSend()}>
            {sending ? 'Sending…' : uploads.uploading ? 'Uploading…' : 'Send reply'}
          </Button>
        </div>
      </div>
    </div>
  );
});
