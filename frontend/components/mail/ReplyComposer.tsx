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
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { Button, Input, cn } from '@/components/ui';
import {
  createMailDraft,
  listMailSignatures,
  updateMailDraft,
  type ComposeBody,
  type MailSignature,
} from '@/lib/mailApi';
import type { ComposeOutcome } from './useMailClient';
import { ComposeStatusLine, describeStatus } from './ComposeStatus';
import { RecipientChips, isValidEmail } from './RecipientChips';
import { AttachButton, ComposerAttachments, useAttachmentUploads } from './AttachmentList';
import { RichTextEditor, htmlToText } from './RichTextEditor';
import { ReplyIcon, CloseIcon } from './icons';

function signatureBlock(sig: MailSignature): string {
  return sig.html.trim() ? `<p>-- </p>${sig.html}` : '';
}

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
        'to_address' | 'subject' | 'body' | 'cc' | 'attachments' | 'in_reply_to' | 'body_html' | 'draft_id'
      >,
    ) => Promise<ComposeOutcome>;
    /** Collapse the composer back to the compact reply action bar. */
    onCollapse?: () => void;
    /** When true (default), the send has an undo window; no confirm needed.
     *  Pass false for external providers (Gmail/M365) whose sends are immediate
     *  and irreversible, to show a brief inline confirm before sending. */
    hasUndoWindow?: boolean;
  }
>(function ReplyComposer(
  { defaultTo, defaultCc, defaultSubject, workspaceId, mailboxId, inReplyTo, onSend, onCollapse, hasUndoWindow = true },
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
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [signatures, setSignatures] = useState<MailSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string>('none');
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmExternal, setConfirmExternal] = useState(false);

  const bodyRef = useRef<HTMLLabelElement>(null);
  const appliedSignature = useRef<string>('');
  const saveTimer = useRef<number | null>(null);
  const lastSavedSnapshot = useRef<string>('');
  const uploads = useAttachmentUploads(workspaceId, mailboxId);
  useEffect(() => {
    lastSavedSnapshot.current = JSON.stringify({
      to: defaultTo.filter(Boolean),
      cc: defaultCc ?? [],
      subject: defaultSubject,
      body: '',
      attachments: [],
      draftId: null,
      inReplyTo: inReplyTo ?? null,
    });
  }, [defaultTo, defaultCc, defaultSubject, inReplyTo]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => bodyRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus(),
    }),
    [],
  );

  useEffect(() => {
    if (!workspaceId || !mailboxId) return;
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
  }, [workspaceId, mailboxId]);

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
      subject,
      body,
      attachments: uploads.refs(),
      draftId,
      inReplyTo,
    });
  }

  function hasDraftContent(): boolean {
    return to.length > 0;
  }

  async function persistDraft(): Promise<{ draft_id: string | null; updated: boolean } | null> {
    if (!workspaceId || !mailboxId || sending || draftSaving || !hasDraftContent()) return null;
    const attachments = uploads.refs();
    const payload = {
      to_address: to.join(', '),
      subject: subject.trim() || undefined,
      body: htmlToText(body) || undefined,
      body_html: body.trim() || undefined,
      ...(cc.length > 0 ? { cc } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      // inReplyTo is the MESSAGE id being replied to — send it as in_reply_to (the
      // header hint the backend resolves), NOT in_reply_to_thread_id. The backend
      // resolves it to In-Reply-To/References so a saved reply-draft threads.
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
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
        subject,
        body,
        attachments,
        draftId: savedDraftId,
        inReplyTo,
      });
      return result;
    } catch {
      return null;
    } finally {
      setDraftSaving(false);
    }
  }

  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const snapshot = buildSnapshot();
    if (snapshot === lastSavedSnapshot.current) return;
    saveTimer.current = window.setTimeout(() => {
      void persistDraft();
    }, 2000);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [to, cc, subject, body, draftId, workspaceId, mailboxId, sending, draftSaving, uploads.items, inReplyTo]);

  useEffect(() => {
    if (!draftSavedAt) return;
    const t = window.setTimeout(() => setDraftSavedAt(null), 4000);
    return () => window.clearTimeout(t);
  }, [draftSavedAt]);

  useEffect(() => {
    setConfirmEmpty(false);
    setConfirmExternal(false);
  }, [subject, body, hasUndoWindow]);

  const invalidCount = [...to, ...cc].filter((a) => !isValidEmail(a)).length;
  const canSend =
    to.length > 0 && invalidCount === 0 && htmlToText(body).length > 0 && !sending && !uploads.uploading;

  async function saveAndCollapse() {
    await persistDraft();
    onCollapse?.();
  }

  async function handleSend() {
    if (!canSend) return;
    if (subject.trim() === '' && !confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    if (!hasUndoWindow && !confirmExternal) {
      setConfirmExternal(true);
      return;
    }
    setConfirmEmpty(false);
    setConfirmExternal(false);
    setSending(true);
    setError(null);
    setStatus(null);
    const attachments = uploads.refs();
    const res = await onSend({
      to_address: to.join(', '),
      subject: subject.trim() || undefined,
      body: htmlToText(body) || undefined,
      body_html: body.trim() || undefined,
      ...(cc.length > 0 ? { cc } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
      ...(draftId ? { draft_id: draftId } : {}),
    });
    setSending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not record your reply.');
      return;
    }
    setStatus(res.message?.status ?? null);
    // A messageless ok = the undo-send lane accepted the reply (it's a scheduled
    // send in its undo window; the UndoSendBar reports the truthful outcome).
    if (describeStatus(res.message?.status).sent || !res.message) {
      setBody('');
      uploads.reset();
      setDraftId(null);
      setDraftSavedAt(null);
      lastSavedSnapshot.current = '';
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
        'eops-rise-in rounded-token-lg border border-subtle bg-surface-raised/50 p-3.5 shadow-token transition-colors duration-fast ease-token',
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
            onClick={() => void saveAndCollapse()}
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
            <RecipientChips
              value={to}
              onChange={setTo}
              autoFocus
              aria-label="To"
              workspaceId={workspaceId}
              mailboxId={mailboxId}
            />
          </div>
        </div>

        {showCc && (
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

        <label className="block" ref={bodyRef}>
          <span className="mb-1 block text-[11px] font-medium text-tertiary">Message</span>
          <RichTextEditor
            value={body}
            onChange={setBody}
            disabled={sending}
            placeholder="Write your reply…  (drop files here to attach)"
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

        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-live="polite"
            className={cn(
              'text-[11px] text-tertiary transition-opacity duration-token ease-token',
              draftSavedAt ? 'opacity-100' : 'opacity-0',
            )}
          >
            {draftSavedAt
              ? `Saved · ${new Date(draftSavedAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
              : 'Saved'}
          </span>
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
        </div>

        <div className="flex items-center justify-end gap-2">
          {uploads.supported && (
            <AttachButton
              onFiles={uploads.addFiles}
              disabled={sending || !mailboxId}
              className="mr-auto"
            />
          )}
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => void saveAndCollapse()}>
            Save draft & close
          </Button>
          {confirmExternal ? (
            <span className="mr-1 text-xs text-warning">Send now? External sends can&apos;t be undone.</span>
          ) : confirmEmpty ? (
            <span className="mr-1 text-xs text-warning">This email has no subject.</span>
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
        </div>
      </div>
    </div>
  );
});
