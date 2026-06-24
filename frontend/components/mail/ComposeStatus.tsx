'use client';

/**
 * Honest interpretation of a compose/reply result `status`.
 *
 * The mail engine is often DORMANT, so a compose is RECORDED but not sent and
 * comes back `status: 'failed'`. That is expected, not a failure to hide — so we
 * translate it into calm, truthful copy ("Recorded — will send once the engine
 * is live") rather than a red error or a misleading "Sent". When the engine is
 * live and the message genuinely sends/queues, we say so.
 */

import { Badge, type BadgeVariant } from '@/components/ui';

export interface StatusMeta {
  /** Did the message actually leave (or get queued to leave)? */
  sent: boolean;
  label: string;
  detail: string;
  tone: BadgeVariant;
}

/**
 * Map a raw backend status string to UI copy. `failed` is the dormant-engine
 * case — recorded, will send once the engine is connected — so it reads calm,
 * not alarming. Unknown statuses are echoed verbatim so we never lie.
 */
export function describeStatus(status: string | null | undefined): StatusMeta {
  const s = (status ?? '').toLowerCase();
  switch (s) {
    case 'sent':
      return { sent: true, label: 'Sent', detail: 'Your message was sent.', tone: 'success' };
    case 'queued':
    case 'sending':
      return {
        sent: true,
        label: 'Queued',
        detail: 'Your message is queued to send.',
        tone: 'info',
      };
    case 'draft':
      return {
        sent: false,
        label: 'Saved as draft',
        detail: 'Saved as a draft — not sent yet.',
        tone: 'neutral',
      };
    case 'failed':
    case '':
      return {
        sent: false,
        label: 'Recorded',
        detail: 'Recorded — will send once the mail engine is connected.',
        tone: 'warning',
      };
    default:
      // Unknown status — surface it honestly rather than guessing.
      return {
        sent: false,
        label: status ?? 'Recorded',
        detail: `Recorded with status “${status}”.`,
        tone: 'neutral',
      };
  }
}

/** A one-line status readout (badge + plain-language detail). */
export function ComposeStatusLine({ status }: { status: string | null | undefined }) {
  const meta = describeStatus(status);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[11px] leading-5 text-tertiary">
      <Badge variant={meta.tone}>{meta.label}</Badge>
      <span>{meta.detail}</span>
    </span>
  );
}
