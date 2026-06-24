'use client';

/**
 * Inline reply composer for the open thread (right pane of the mail client).
 *
 * Prefilled by the page to the thread's other participant + a "Re: <subject>".
 * Posts through the hook's `reply` (which threads it with `in_reply_to_thread_id`)
 * and then surfaces the TRUTHFUL backend status: when the mail engine is dormant
 * a reply comes back `status: 'failed'` — recorded, not sent — so we say exactly
 * that rather than flashing a misleading "Sent".
 */

import { useState } from 'react';
import { Button, Input } from '@/components/ui';
import type { ComposeOutcome } from './useMailClient';
import { ComposeStatusLine, describeStatus } from './ComposeStatus';

export function ReplyComposer({
  defaultTo,
  defaultSubject,
  onSend,
}: {
  defaultTo: string;
  defaultSubject: string;
  /** Sends the reply; the page wires this to the hook's `reply`. */
  onSend: (body: { to_address: string; subject?: string; body?: string }) => Promise<ComposeOutcome>;
}) {
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSend = to.trim().length > 0 && body.trim().length > 0 && !sending;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    setStatus(null);
    const res = await onSend({
      to_address: to.trim(),
      subject: subject.trim() || undefined,
      body: body.trim() || undefined,
    });
    setSending(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not record your reply.');
      return;
    }
    // Truthful status. If it actually sent, clear the draft; otherwise keep it
    // visible so nothing the user wrote is silently lost.
    setStatus(res.message?.status ?? null);
    if (describeStatus(res.message?.status).sent) setBody('');
  }

  return (
    <div className="border-t border-subtle bg-surface-base/40 p-4">
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block text-[11px] font-medium text-tertiary">To</span>
            <Input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="name@example.com"
              autoComplete="off"
              spellCheck={false}
              inputMode="email"
            />
          </label>
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
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-tertiary">Reply</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="Write a reply…"
            className="block w-full resize-y rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {error ? (
              <p className="text-xs text-danger">{error}</p>
            ) : status ? (
              <ComposeStatusLine status={status} />
            ) : (
              <p className="text-[11px] text-muted">
                Replies thread into this conversation.
              </p>
            )}
          </div>
          <Button size="sm" disabled={!canSend} onClick={() => void handleSend()}>
            {sending ? 'Sending…' : 'Send reply'}
          </Button>
        </div>
      </div>
    </div>
  );
}
