'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Skeleton, SkeletonText } from '@/components/ui';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { ApiError } from '@/lib/api';
import { isAdminRole } from '@/lib/workspacesApi';
import {
  checkMailDomainVerification,
  listMailDomains,
  requestMailDomainVerification,
  type MailDomainView,
} from '@/lib/mailDomainsApi';

type Load = 'loading' | 'ready' | 'error';

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export default function MailDomainsPage() {
  const router = useRouter();
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;
  const canManage = isAdminRole(activeWorkspace?.role);
  const [items, setItems] = useState<MailDomainView[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const guard401 = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/auth/login');
        return true;
      }
      return false;
    },
    [router],
  );

  const fetchFor = useCallback(
    async (id: string, silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const response = await listMailDomains(id);
        setItems(response.items);
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not load mail domains.'));
        setLoad('error');
      }
    },
    [guard401],
  );

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    void fetchFor(workspaceId);
  }, [fetchFor, workspaceId, workspaceLoad]);

  async function requestChallenge(domain: MailDomainView): Promise<void> {
    if (!workspaceId) return;
    setBusy(`${domain.id}:request`);
    setError(null);
    try {
      await requestMailDomainVerification(workspaceId, domain.id);
      await fetchFor(workspaceId, true);
    } catch (err) {
      if (!guard401(err)) setError(messageOf(err, `Could not start verification for ${domain.domain}.`));
    } finally {
      setBusy(null);
    }
  }

  async function checkChallenge(domain: MailDomainView): Promise<void> {
    if (!workspaceId) return;
    setBusy(`${domain.id}:check`);
    setError(null);
    try {
      const updated = await checkMailDomainVerification(workspaceId, domain.id);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      if (!guard401(err)) setError(messageOf(err, `Could not check ${domain.domain}.`));
    } finally {
      setBusy(null);
    }
  }

  async function copyText(key: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600);
    } catch {
      setError('Could not copy to the clipboard.');
    }
  }

  return (
    <div className="space-y-7">
      <header className="relative overflow-hidden rounded-[20px] border border-subtle bg-surface-raised shadow-token">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_0%,rgb(var(--accent-2)/0.18),transparent_55%),radial-gradient(95%_130%_at_0%_100%,rgb(var(--accent)/0.14),transparent_55%)]" />
        <div className="relative flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="protected" dot>domain verification</Badge>
              <Badge variant="info">send-kit trust boundary</Badge>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
              Prove the domains you send from.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">
              Add the TXT record below, then check it here. Verified domains are treated as
              internal by the agent send guard.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => workspaceId && void fetchFor(workspaceId)}
            disabled={!workspaceId || load === 'loading'}
          >
            Refresh
          </Button>
        </div>
      </header>

      {!workspaceId && workspaceLoad !== 'loading' ? (
        <Card padded>
          <p className="font-medium text-primary">No active workspace.</p>
          <p className="mt-1 text-sm text-tertiary">Join or select a workspace to manage its mail domains.</p>
        </Card>
      ) : load === 'loading' ? (
        <DomainListSkeleton />
      ) : load === 'error' ? (
        <Card padded>
          <p className="font-medium text-danger">Could not load mail domains.</p>
          <p className="mt-1 text-sm text-tertiary">{error}</p>
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => workspaceId && void fetchFor(workspaceId)}
          >
            Try again
          </Button>
        </Card>
      ) : items.length === 0 ? (
        <Card padded>
          <p className="font-medium text-primary">No mail domains are bound to this workspace.</p>
          <p className="mt-1 text-sm text-tertiary">
            Bind a domain through the mail-engine administration workflow, then return here to verify it.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((domain) => (
            <DomainCard
              key={domain.id}
              domain={domain}
              canManage={canManage}
              busy={busy}
              copied={copied}
              onRequest={() => void requestChallenge(domain)}
              onCheck={() => void checkChallenge(domain)}
              onCopy={copyText}
            />
          ))}
        </div>
      )}

      {error && load !== 'error' && (
        <p role="alert" className="rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <Card padded>
        <h2 className="text-sm font-semibold text-primary">What verification gates</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-tertiary">
          The send-kit guard uses only domains whose <code className="mono text-primary">verified</code> state
          is true when deciding whether a recipient is internal. A later DNS failure records an error but
          does not revoke that state automatically; an administrator must decide what to do.
        </p>
      </Card>
    </div>
  );
}

function DomainCard({
  domain,
  canManage,
  busy,
  copied,
  onRequest,
  onCheck,
  onCopy,
}: {
  domain: MailDomainView;
  canManage: boolean;
  busy: string | null;
  copied: string | null;
  onRequest: () => void;
  onCheck: () => void;
  onCopy: (key: string, value: string) => Promise<void>;
}) {
  const hasChallenge = !!domain.recordName && !!domain.recordValue;
  const requestBusy = busy === `${domain.id}:request`;
  const checkBusy = busy === `${domain.id}:check`;

  return (
    <Card padded>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="mono truncate text-base font-semibold text-primary">{domain.domain}</p>
          <p className="mt-1 text-xs text-muted">
            Last check: {formatDate(domain.lastVerificationCheckAt)}
            {domain.verifiedAt ? ` · verified ${formatDate(domain.verifiedAt)}` : ''}
          </p>
        </div>
        <Badge variant={domain.verified ? 'success' : 'warning'} dot>
          {domain.verified ? 'Verified' : 'Not verified'}
        </Badge>
      </div>

      {hasChallenge ? (
        <div className="mt-5 space-y-3 rounded-token border border-subtle bg-surface-base/60 p-3 sm:p-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">DNS TXT record to add</p>
            <p className="mt-1 text-xs text-tertiary">
              Add this record at the domain’s DNS provider. DNS propagation can take a few minutes.
            </p>
          </div>
          <RecordRow
            label="Name"
            value={domain.recordName!}
            copied={copied === `${domain.id}:name`}
            onCopy={() => void onCopy(`${domain.id}:name`, domain.recordName!)}
          />
          <RecordRow label="Type" value={domain.recordType ?? 'TXT'} />
          <RecordRow
            label="Value"
            value={domain.recordValue!}
            copied={copied === `${domain.id}:value`}
            onCopy={() => void onCopy(`${domain.id}:value`, domain.recordValue!)}
          />
          <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
            {canManage ? (
              <Button variant="primary" size="sm" onClick={onCheck} disabled={busy !== null}>
                {checkBusy ? 'Checking…' : 'Check now'}
              </Button>
            ) : (
              <p className="text-xs text-tertiary">An admin or owner must check this record.</p>
            )}
            {canManage && (
              <Button variant="ghost" size="sm" onClick={onRequest} disabled={busy !== null}>
                {requestBusy ? 'Generating…' : 'Generate a new record'}
              </Button>
            )}
          </div>
        </div>
      ) : canManage ? (
        <div className="mt-5 flex flex-col gap-3 rounded-token border border-dashed border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-tertiary">No TXT challenge has been generated yet.</p>
          <Button variant="secondary" size="sm" onClick={onRequest} disabled={busy !== null}>
            {requestBusy ? 'Generating…' : 'Generate TXT record'}
          </Button>
        </div>
      ) : (
        <p className="mt-5 text-sm text-tertiary">Ask an admin or owner to generate a TXT challenge.</p>
      )}

      {domain.lastVerificationError && (
        <p className="mt-3 rounded-token border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning">
          Last verification error: {domain.lastVerificationError}
        </p>
      )}
    </Card>
  );
}

function RecordRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[72px_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
      <span className="text-xs font-medium text-muted">{label}</span>
      <code className="mono min-w-0 break-all rounded-token bg-surface-overlay px-2 py-1.5 text-xs text-primary">
        {value}
      </code>
      {onCopy ? (
        <Button variant="ghost" size="sm" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}

function DomainListSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading mail domains">
      {[0, 1].map((key) => (
        <Card key={key} padded>
          <div className="flex items-start justify-between gap-3">
            <Skeleton w="35%" h={18} />
            <Skeleton w={92} h={24} />
          </div>
          <SkeletonText lines={4} className="mt-5" />
        </Card>
      ))}
    </div>
  );
}
