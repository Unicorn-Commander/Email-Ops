'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui';
import {
  ApiError,
  disconnectProvider,
  type ConnectedProvider,
  type DisconnectProviderResponse,
} from '@/lib/api';
import { providerMeta } from '@/lib/cleaner-model';

const REVOKE_URL: Record<ConnectedProvider, string> = {
  gmail: 'https://myaccount.google.com/connections',
  microsoft: 'https://myaccount.microsoft.com/permissions',
};

const FAILURE_COPY: Record<string, string> = {
  broker_unavailable: 'The identity broker is unavailable. Nothing was changed. Try again.',
  sso_session_expired:
    'Your sign-in session expired. Sign out and back in, then try Disconnect again. Nothing was changed.',
  broker_rejected: 'The identity broker refused to unlink this account. Nothing was changed.',
  mailbox_update_failed:
    'The provider link was removed, but the mailbox record could not be marked inactive. Try again.',
  refresh_token_clear_failed:
    'The provider link was removed and the mailbox was marked inactive, but the saved refresh token could not be cleared. Try again.',
  owner_unknown: 'This account has no identity to match a mailbox. Nothing was changed.',
};

export function DisconnectControl({
  provider,
  linked,
  onDisconnected,
  disconnect = disconnectProvider,
}: {
  provider: ConnectedProvider;
  linked: boolean;
  onDisconnected?: () => void;
  /** Test seam. Production uses the connected-accounts disconnect endpoint. */
  disconnect?: typeof disconnectProvider;
}) {
  const meta = providerMeta(provider);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DisconnectProviderResponse | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await disconnect(provider);
      setResult(next);
      setOpen(false);
      onDisconnected?.();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const fallback = code ? FAILURE_COPY[code] : undefined;
      setError(
        fallback ||
          (err instanceof Error ? err.message : 'Could not disconnect this account. Nothing was changed.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      <Button
        variant="ghost"
        disabled={!linked || busy}
        title={linked ? undefined : 'Connect this account before you can disconnect it.'}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {busy ? 'Disconnecting...' : 'Disconnect'}
      </Button>

      {open ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              setError(null);
              setOpen(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-md rounded-token-lg border border-border bg-surface-elevated text-secondary shadow-token-lg"
          >
            <div className="space-y-3 p-5">
              <h2 id={titleId} className="text-base font-semibold text-primary">
                Disconnect {meta.label}?
              </h2>
              <p className="text-sm text-tertiary">
                This removes the {meta.label} link from your Email-Ops sign-in and marks the
                mailbox inactive. Your mail stays at {meta.label}.
              </p>
              <p className="text-sm text-secondary">
                Email-Ops does not delete messages or history. Revoking access at {meta.label} is
                still recommended. Email-Ops can remove its own link, but {meta.label} may keep
                the app consent until you remove it there.
              </p>
              <a
                href={REVOKE_URL[provider]}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm font-medium text-accent underline-offset-2 hover:underline"
              >
                Open {meta.label} app permissions
              </a>
              {error ? (
                <p role="alert" className="text-xs leading-5 text-danger">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-subtle p-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setError(null);
                  setOpen(false);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => void confirm()} disabled={busy}>
                {busy ? 'Disconnecting...' : `Disconnect ${meta.shortLabel}`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {result ? (
        <div role="status" className="mt-2 space-y-1 text-xs leading-5 text-secondary">
          <p>
            Disconnected {meta.label}. The broker link for your account is{' '}
            {result.broker === 'already_absent' ? 'already removed' : 'removed'}.{' '}
            {result.mailboxes_deactivated === 1
              ? '1 mailbox record was marked inactive.'
              : `${result.mailboxes_deactivated} mailbox records were marked inactive.`}{' '}
            Mail at {meta.label} was not deleted, and Email-Ops history was kept.
          </p>
          <p>
            {result.refresh_token_cleared
              ? 'The saved sign-in refresh token was cleared because no other provider link uses it. Sign out and back in before you connect an account again.'
              : 'The saved sign-in refresh token was kept. It is still used for your sign-in or another linked provider.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
