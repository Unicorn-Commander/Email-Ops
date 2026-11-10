'use client';

import Link from 'next/link';
import { Button, cn } from '../ui';
import { MailIcon } from './icons';
import type { MailReadUnavailable } from '../../lib/mailApi';

/**
 * Inbox / thread empty-vs-unavailable copy. A connected mailbox that could not
 * be read must never look like an empty inbox. Next-step only — never echo
 * tokens or provider error bodies.
 */
const COPY: Record<
  MailReadUnavailable,
  { t: string; d: string; action: 'retry' | 'reconnect' }
> = {
  engine_not_configured: {
    t: 'Mail service is not available right now',
    d: 'This mailbox is connected, but Email-Ops cannot read it yet. Try again in a moment. Your mail has not been deleted.',
    action: 'retry',
  },
  engine_unreachable: {
    t: 'Mail service is not available right now',
    d: 'This mailbox is connected, but the mail service did not respond. Try again. Your mail has not been deleted.',
    action: 'retry',
  },
  provider_auth_failed: {
    t: 'Reconnect this mailbox',
    d: 'Email-Ops could not sign in to this mailbox. Reconnect the account on Accounts, then open Mail again. Your mail is still at your provider.',
    action: 'reconnect',
  },
  provider_error: {
    t: 'Could not load this mailbox',
    d: 'The mail provider did not return this folder. Try again. Your mail has not been deleted.',
    action: 'retry',
  },
};

export function MailUnavailableView({
  status,
  onRetry,
}: {
  status: MailReadUnavailable;
  onRetry: () => void;
}) {
  const copy = COPY[status];
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center" role="status">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-surface-overlay text-tertiary">
        <MailIcon className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-primary">{copy.t}</p>
      <p className={cn('max-w-xs text-xs leading-5 text-tertiary')}>{copy.d}</p>
      {copy.action === 'reconnect' ? (
        <Link
          href="/accounts"
          className="mt-2 text-xs font-medium text-accent hover:underline"
        >
          Reconnect the account
        </Link>
      ) : (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
