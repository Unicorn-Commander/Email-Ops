'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, cn } from '../ui';
import { MailIcon } from './icons';
import { getProviderLinkUrl, type ConnectedProvider } from '../../lib/api';
import { ExternalImapConnect } from './ExternalImapConnect';

export type ListBanner = 'no-workspace' | 'error' | 'loading' | 'no-mailboxes' | 'no-space';

export function ListBannerView({
  banner,
  error,
  spaceName,
  onRetry,
}: {
  banner: ListBanner;
  error: string | null;
  spaceName: string | null;
  onRetry: () => void;
}) {
  const [linking, setLinking] = useState<ConnectedProvider | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function connect(provider: ConnectedProvider) {
    setLinkError(null);
    setLinking(provider);
    try {
      const { url } = await getProviderLinkUrl(provider);
      window.location.href = url;
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Could not start account linking. Try again.');
      setLinking(null);
    }
  }

  const map: Record<ListBanner, { t: string; d: string }> = {
    'no-workspace': {
      t: 'No workspace yet',
      d: 'Your account isn’t a member of an Email-Ops workspace, so there are no mailboxes to show.',
    },
    error: { t: 'Could not load your mail', d: error ?? 'Unknown error.' },
    loading: { t: 'Loading…', d: 'Fetching your mailboxes.' },
    'no-mailboxes': {
      t: 'No mailboxes yet',
      d: 'Connect your own Gmail or Microsoft 365 mailbox. After sign-in, choose Add to Mail on Accounts, then open Mail.',
    },
    'no-space': {
      t: `No mailboxes in ${spaceName ?? 'this space'}`,
      d: 'This space doesn’t include any mailboxes yet. Switch back to “All”, or add some.',
    },
  };
  const copy = map[banner];
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-surface-overlay text-tertiary">
        <MailIcon className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-primary">{copy.t}</p>
      <p className={cn('max-w-xs text-xs leading-5', banner === 'error' ? 'text-danger' : 'text-tertiary')}>
        {copy.d}
      </p>
      {banner === 'no-mailboxes' && (
        <div className="mt-3 flex w-full max-w-xs flex-col gap-2">
          <Button disabled={linking !== null} onClick={() => void connect('gmail')}>
            {linking === 'gmail' ? 'Opening Gmail…' : 'Connect Gmail'}
          </Button>
          <Button variant="secondary" disabled={linking !== null} onClick={() => void connect('microsoft')}>
            {linking === 'microsoft' ? 'Opening Microsoft 365…' : 'Connect Microsoft 365'}
          </Button>
          {linkError && <p role="alert" className="text-xs leading-5 text-danger">{linkError}</p>}
          <ExternalImapConnect onConnected={onRetry} />
          <Link href="/accounts" className="mt-1 text-xs font-medium text-accent hover:underline">
            Already connected? Add to Mail on Accounts
          </Link>
        </div>
      )}
      {banner === 'error' && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
