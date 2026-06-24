'use client';

/**
 * Top-level "Compose" dialog — a new message from the selected mailbox.
 *
 * Collects to_address / subject / body and posts through the hook's `compose`.
 * On success it shows the TRUTHFUL backend status inline (the engine may be
 * dormant → "Recorded — will send once the engine is live") and only auto-closes
 * when the message genuinely sent; otherwise it keeps the dialog open with the
 * status so the user sees what happened to what they wrote.
 */

import { useEffect, useState } from 'react';
import { Button, Dialog, Input } from '@/components/ui';
import type { ComposeOutcome } from './useMailClient';
import { ComposeStatusLine, describeStatus } from './ComposeStatus';

export function ComposeDialog({
  open,
  onClose,
  fromAddress,
  onCompose,
}: {
  open: boolean;
  onClose: () => void;
  /** The address the message is sent from (the selected mailbox), for context. */
  fromAddress: string | null;
  onCompose: (body: {
    to_address: string;
    subject?: string;
    body?: string;
  }) => Promise<ComposeOutcome>;
}) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset everything when the dialog re-opens.
  useEffect(() => {
    if (open) {
      setTo('');
      setSubject('');
      setBody('');
      setStatus(null);
      setError(null);
      setSending(false);
    }
  }, [open]);

  const canSend = to.trim().length > 0 && !sending;

  function handleOpenChange(next: boolean) {
    if (!next && !sending) onClose();
  }

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    setStatus(null);
    const res = await onCompose({
      to_address: to.trim(),
      subject: subject.trim() || undefined,
      body: body.trim() || undefined,
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

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="New message"
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
          <Button variant="secondary" size="sm" disabled={sending} onClick={() => handleOpenChange(false)}>
            {status ? 'Close' : 'Cancel'}
          </Button>
          <Button size="sm" disabled={!canSend} onClick={() => void handleSend()}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-tertiary">To</span>
          <Input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
            autoComplete="off"
            spellCheck={false}
            inputMode="email"
            autoFocus
          />
        </label>
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
            placeholder="Write your message…"
            className="block w-full resize-y rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </label>

        {error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : status ? (
          <ComposeStatusLine status={status} />
        ) : null}
      </form>
    </Dialog>
  );
}
