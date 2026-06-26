'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Badge, Card, Skeleton, cn } from '@/components/ui';
import { useConnectedAccounts } from '@/components/ConnectedAccountsProvider';
import { useInboxStats } from '@/components/useInboxStats';
import { formatBytes, providerMeta, storagePercent } from '@/lib/cleaner-model';
import {
  fetchProfile,
  getProviderLinkUrl,
  type ConnectedProvider,
  type LinkedAccountView,
} from '@/lib/api';
import { connectMailbox } from '@/lib/mailApi';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';

export default function AccountsPage() {
  const { accounts, loading, error, refreshAccounts } = useConnectedAccounts();
  // The active workspace (the OUTER org tenant, read from the ambient provider so
  // "Add to Mail" re-targets when the org switches) + the caller's identity email
  // — what "Add to Mail" needs to register a connected account as a mailbox. The
  // connected-account record carries no address, but the linked account IS the
  // caller's own identity (the broker links the IdP to the signed-in user), so
  // the profile email is the right address to register — no need to prompt.
  const { activeWorkspace } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;
  const [selfEmail, setSelfEmail] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const profile = await fetchProfile();
        if (!alive) return;
        setSelfEmail(profile.email?.trim() || null);
      } catch {
        // Non-fatal: "Add to Mail" simply stays disabled if we can't resolve the
        // identity. The cleaner cockpit below is unaffected.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Returning from a Keycloak account-link round-trip (/accounts?linked=google):
  // refresh link status and clean the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('linked')) {
      void refreshAccounts();
      window.history.replaceState({}, '', '/accounts');
    }
  }, [refreshAccounts]);

  const firstUnlinked = accounts.find((a) => !a.linked)?.provider;

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Badge variant="protected">consent first</Badge>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-primary">
            Connected Accounts
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-tertiary">
            Provider access lives in the Keycloak broker. This screen lists token health and
            scopes, and never deletes mail. Disconnecting access deletes no messages.
          </p>
          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="secondary" onClick={() => void refreshAccounts()} disabled={loading}>
            Refresh accounts
          </Button>
          <Button
            onClick={() => firstUnlinked && void linkProvider(firstUnlinked)}
            disabled={!firstUnlinked}
            title={firstUnlinked ? undefined : 'All providers are connected'}
          >
            {firstUnlinked ? `Connect ${providerMeta(firstUnlinked).shortLabel}` : 'All connected'}
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i} padded>
              <div className="flex items-start gap-4">
                <Skeleton circle w={48} h={48} />
                <div className="flex-1 space-y-3">
                  <Skeleton w="50%" h={16} />
                  <Skeleton w="72%" h={12} />
                  <Skeleton h={82} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {accounts.map((account) => (
            <AccountCard
              key={account.provider}
              account={account}
              workspaceId={workspaceId}
              selfEmail={selfEmail}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Outcome of adding a connected account to the `/mail` client. */
type AddState =
  | { kind: 'idle' }
  | { kind: 'adding' }
  | { kind: 'added'; address: string }
  | { kind: 'error'; message: string };

function AccountCard({
  account,
  workspaceId,
  selfEmail,
}: {
  account: LinkedAccountView;
  workspaceId: string | null;
  selfEmail: string | null;
}) {
  const meta = providerMeta(account.provider);
  const { load, stats, unavailableReason, error } = useInboxStats(account.provider, account.linked);
  const percent = storagePercent(stats);
  const [linking, setLinking] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [add, setAdd] = useState<AddState>({ kind: 'idle' });

  const connect = async () => {
    setLinkErr(null);
    setLinking(true);
    try {
      await linkProvider(account.provider);
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : 'Could not start linking.');
      setLinking(false);
    }
  };

  // Register this connected account as a workspace mailbox so it shows in /mail.
  // Idempotent server-side, so a re-click just re-confirms the same address.
  const canAdd = account.linked && !!workspaceId && !!selfEmail;
  const addToMail = async () => {
    if (!workspaceId || !selfEmail) return;
    setAdd({ kind: 'adding' });
    try {
      const mailbox = await connectMailbox(workspaceId, {
        provider: account.provider,
        email_address: selfEmail,
      });
      setAdd({ kind: 'added', address: mailbox.email_address || selfEmail });
    } catch (e) {
      setAdd({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not add this account to Mail.',
      });
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="relative p-5">
        <div
          className={cn(
            'absolute inset-x-0 top-0 h-28 bg-gradient-to-br opacity-80',
            meta.accentClass,
          )}
        />
        <div className="relative flex items-start gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-surface-elevated text-lg font-semibold text-primary ring-1 ring-border">
            {meta.initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-primary">{meta.mailboxLabel}</h2>
              <Badge variant="accent">{meta.shortLabel}</Badge>
              <Badge variant={account.linked ? 'success' : 'warning'} dot>
                {account.linked ? 'token valid' : 'not linked'}
              </Badge>
            </div>
            <p className="mt-1 font-mono text-xs text-tertiary">
              {account.linked ? `${account.provider}@broker.email-ops.local` : 'No mailbox linked yet'}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-5 border-t border-subtle p-5">
        <section>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-tertiary">
              Storage gauge
            </p>
            {load === 'loading' ? (
              <Skeleton w={56} h={18} />
            ) : (
              <span className="font-mono text-xs text-tertiary">{percent}%</span>
            )}
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-overlay">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-token ease-token"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 font-mono text-xs text-secondary">
            {stats
              ? `${formatBytes(stats.storage_used_bytes)} used${
                  stats.storage_limit_bytes ? ` of ${formatBytes(stats.storage_limit_bytes)}` : ''
                }`
              : unavailableReason || error || 'Connect to read storage metadata.'}
          </p>
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <ScopeChip label="Read metadata" state={account.linked ? 'on' : 'off'} />
          <ScopeChip label="Read labels" state={account.linked ? 'on' : 'off'} />
          <ScopeChip label="No content" state="locked" />
        </section>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant={account.linked ? 'secondary' : 'primary'}
            onClick={() => void connect()}
            disabled={linking}
          >
            {linking
              ? 'Opening…'
              : account.linked
                ? `Reconnect ${meta.shortLabel}`
                : `Connect ${meta.shortLabel}`}
          </Button>
          <Button variant="ghost" disabled title="Disconnect endpoint is not part of Phase 1.">
            Disconnect
          </Button>
        </div>

        {/* Unified inbox: register this connected account as a /mail mailbox. */}
        {account.linked && (
          <div className="rounded-token border border-subtle bg-surface-base p-3">
            {add.kind === 'added' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="success" dot>
                  Added to Mail
                </Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-tertiary">
                  <span className="font-mono text-secondary">{add.address}</span> is ready in your
                  mail client.
                </span>
                <Link
                  href="/mail"
                  className="shrink-0 rounded-token px-2 py-1 text-xs font-medium text-accent transition-colors duration-fast ease-token hover:bg-surface-overlay/60"
                >
                  Open /mail
                </Link>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-primary">Use this account in Mail</p>
                  <p className="mt-0.5 text-[11px] leading-5 text-tertiary">
                    Read and send {meta.label} from the unified <span className="font-mono">/mail</span>{' '}
                    client.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void addToMail()}
                  disabled={!canAdd || add.kind === 'adding'}
                  title={
                    canAdd
                      ? undefined
                      : 'Resolving your workspace and identity — one moment.'
                  }
                >
                  {add.kind === 'adding' ? 'Adding…' : 'Add to Mail'}
                </Button>
              </div>
            )}
            {add.kind === 'error' && (
              <p className="mt-2 text-[11px] leading-5 text-danger">{add.message}</p>
            )}
          </div>
        )}

        {linkErr && <p className="text-xs leading-5 text-danger">{linkErr}</p>}

        <p className="text-xs leading-5 text-tertiary">
          Connecting links {meta.label} to your account via Magic Unicorn SSO. Disconnecting only
          removes access — it deletes no mail. The cleanup engine is read-only from this screen.
        </p>
      </div>
    </Card>
  );
}

function ScopeChip({ label, state }: { label: string; state: 'on' | 'off' | 'locked' }) {
  return (
    <div className="rounded-token border border-subtle bg-surface-base p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            state === 'on' ? 'bg-success' : state === 'locked' ? 'bg-info' : 'bg-muted',
          )}
        />
        <span className="text-xs font-medium text-primary">{label}</span>
      </div>
      <p className="mt-1 text-[11px] text-tertiary">
        {state === 'on' ? 'Granted by broker' : state === 'locked' ? 'Privacy rail' : 'Pending'}
      </p>
    </div>
  );
}

/** Fetch a Keycloak account-link URL for the provider and send the browser there.
 *  The browser carries its KC SSO session cookie, links the IdP (granting the
 *  gmail.modify / Mail.ReadWrite consent), and returns to /accounts?linked=<provider>. */
async function linkProvider(provider: ConnectedProvider): Promise<void> {
  const { url } = await getProviderLinkUrl(provider);
  window.location.href = url;
}
