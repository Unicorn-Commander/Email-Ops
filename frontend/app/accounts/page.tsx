'use client';

import { Button, Badge, Card, Skeleton, cn } from '@/components/ui';
import { useConnectedAccounts } from '@/components/ConnectedAccountsProvider';
import { useInboxStats } from '@/components/useInboxStats';
import { formatBytes, providerMeta, storagePercent } from '@/lib/cleaner-model';
import { ssoLoginUrl, type LinkedAccountView } from '@/lib/api';

export default function AccountsPage() {
  const { accounts, loading, error, refreshAccounts } = useConnectedAccounts();

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
          <Button onClick={() => startBrokerLogin()}>Add account</Button>
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
            <AccountCard key={account.provider} account={account} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountCard({ account }: { account: LinkedAccountView }) {
  const meta = providerMeta(account.provider);
  const { load, stats, unavailableReason, error } = useInboxStats(account.provider, account.linked);
  const percent = storagePercent(stats);

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
          <Button variant={account.linked ? 'secondary' : 'primary'} onClick={() => startBrokerLogin()}>
            {account.linked ? 'Reconnect' : 'Connect'}
          </Button>
          <Button variant="secondary" onClick={() => startBrokerLogin()}>
            Provider sign-in
          </Button>
          <Button variant="ghost" disabled title="Disconnect endpoint is not part of Phase 1.">
            Disconnect
          </Button>
        </div>

        <p className="text-xs leading-5 text-tertiary">
          Disconnecting only removes access. It deletes no mail. The cleanup engine is read-only from
          this screen.
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

function startBrokerLogin() {
  window.location.href = ssoLoginUrl();
}
