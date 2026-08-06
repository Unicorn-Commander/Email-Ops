'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, CardParts, Select, Skeleton, useConfirm } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { listMailboxes, type MailboxView } from '@/lib/mailboxApi';
import {
  fetchMobileconfigBlob,
  getConnection,
  resetAppPassword,
  type DeviceConnectionSettings,
  type ManualClientSettings,
} from '@/lib/deviceApi';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function localpart(email: string): string {
  return email.split('@')[0]?.replace(/[^a-zA-Z0-9.-]/g, '-') || 'mailbox';
}

export default function ConnectDevicePage() {
  const { activeWorkspace } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;
  const confirm = useConfirm();
  const [mailboxes, setMailboxes] = useState<MailboxView[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [connection, setConnection] = useState<DeviceConnectionSettings | null>(null);
  const [state, setState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!workspaceId) return;
    setState('loading');
    setError(null);
    void (async () => {
      try {
        const data = await listMailboxes(workspaceId);
        if (!alive) return;
        const ownCandidates = data.items.filter((m) => {
          const provider = (m.provider ?? 'stalwart').toLowerCase();
          return m.owner_kind === 'HUMAN' && m.active && provider !== 'gmail' && provider !== 'microsoft';
        });
        setMailboxes(ownCandidates);
        const preferred = ownCandidates.find((m) => m.is_default) ?? ownCandidates[0];
        setSelectedId((current) => current || preferred?.id || '');
        setState('ready');
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'Could not load mailboxes.');
        setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    if (!workspaceId || !selectedId) {
      setConnection(null);
      return;
    }
    setError(null);
    setPassword(null);
    void (async () => {
      try {
        const data = await getConnection(workspaceId, selectedId);
        if (!alive) return;
        setConnection(data);
      } catch (e) {
        if (!alive) return;
        setConnection(null);
        setError(e instanceof Error ? e.message : 'Could not load connection settings.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, selectedId]);

  const selectedMailbox = useMemo(
    () => mailboxes.find((m) => m.id === selectedId) ?? null,
    [mailboxes, selectedId],
  );

  const downloadProfile = async () => {
    if (!workspaceId || !selectedId || !connection) return;
    setBusy('download');
    setError(null);
    try {
      const blob = await fetchMobileconfigBlob(workspaceId, selectedId);
      downloadBlob(blob, `${localpart(connection.email)}-fabrikam-email.mobileconfig`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download the profile.');
    } finally {
      setBusy(null);
    }
  };

  const generatePassword = async () => {
    if (!workspaceId || !selectedId) return;
    const ok = await confirm({
      title: 'Generate a new mail password?',
      description:
        'This replaces the mailbox password used by native mail apps. Existing devices must be updated.',
      confirmLabel: 'Generate password',
      destructive: true,
    });
    if (!ok) return;
    setBusy('password');
    setError(null);
    try {
      const result = await resetAppPassword(workspaceId, selectedId);
      setPassword(result.password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate a mail password.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-7">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Badge variant="accent">Setup</Badge>
          <h1 className="mt-3 text-3xl font-semibold text-primary">Connect a device</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-tertiary">
            Set up your mailbox in Apple Mail, Outlook, Thunderbird, Android, or any IMAP client
            with the exact server settings for your account.
          </p>
          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </div>
        {mailboxes.length > 1 && (
          <div className="w-full max-w-sm">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-tertiary">
              Mailbox
            </label>
            <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              {mailboxes.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {mailbox.email_address}
                </option>
              ))}
            </Select>
          </div>
        )}
      </header>

      {state === 'loading' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Skeleton h={220} />
          <Skeleton h={220} />
        </div>
      ) : mailboxes.length === 0 ? (
        <Card padded>
          <p className="text-sm text-tertiary">No human mailbox is available for device setup.</p>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <Card>
            <CardParts.Header>
              <div>
                <CardParts.Title>Apple iPhone / iPad / Mac</CardParts.Title>
                <p className="mt-1 text-xs text-tertiary">{connection?.email ?? selectedMailbox?.email_address}</p>
              </div>
              <Tooltip content="The profile isn't code-signed, so Apple shows a warning during install — expected, and safe to accept">
                <span tabIndex={0}><Badge variant="warning">Unsigned</Badge></span>
              </Tooltip>
            </CardParts.Header>
            <CardParts.Body className="space-y-4">
              <Tooltip content="A .mobileconfig with the exact IMAP/SMTP settings — open it on the Apple device to add the account">
                <Button onClick={() => void downloadProfile()} disabled={!connection || busy === 'download'}>
                  {busy === 'download' ? 'Downloading...' : 'Download config profile'}
                </Button>
              </Tooltip>
              <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-secondary">
                <li>Open the downloaded profile on the device.</li>
                <li>Go to Settings, then Profile Downloaded.</li>
                <li>Tap Install and enter the generated mail password when prompted.</li>
                <li>Apple will show an Unsigned warning because the profile is not signed.</li>
              </ol>
            </CardParts.Body>
          </Card>

          <Card>
            <CardParts.Header>
              <div>
                <CardParts.Title>Your mail password</CardParts.Title>
                <p className="mt-1 text-xs text-tertiary">Use this password only in mail apps.</p>
              </div>
            </CardParts.Header>
            <CardParts.Body className="space-y-4">
              <Tooltip content="Mints the app password native mail clients use — shown once, and it replaces the previous one (update existing devices)">
                <Button
                  variant="danger"
                  onClick={() => void generatePassword()}
                  disabled={!connection || busy === 'password'}
                >
                  {busy === 'password' ? 'Generating...' : 'Generate mail password'}
                </Button>
              </Tooltip>
              {password ? (
                <div className="rounded-token border border-subtle bg-surface-base p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-warning">
                    Save this now
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto rounded-token bg-surface-overlay px-2 py-2 font-mono text-sm text-primary">
                      {password}
                    </code>
                    <CopyButton value={password} />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-tertiary">
                    Email-Ops does not store or show this plaintext password again.
                  </p>
                </div>
              ) : (
                <p className="text-sm leading-6 text-tertiary">
                  Generating a password resets the mailbox password used by native mail clients.
                </p>
              )}
            </CardParts.Body>
          </Card>
        </div>
      )}

      {connection && <ManualSettingsGrid items={connection.manual} />}
    </div>
  );
}

function ManualSettingsGrid({ items }: { items: ManualClientSettings[] }) {
  return (
    <section className="grid gap-4 xl:grid-cols-2">
      {items.map((item) => (
        <Card key={item.client}>
          <CardParts.Header>
            <CardParts.Title>{item.client}</CardParts.Title>
          </CardParts.Header>
          <CardParts.Body className="space-y-4">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-secondary">
              {item.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="grid gap-2">
              <FieldRow label="IMAP host" value={item.fields.imapHost} />
              <FieldRow label="IMAP port" value={String(item.fields.imapPort)} />
              <FieldRow label="IMAP security" value={item.fields.imapSecurity} />
              <FieldRow label="SMTP host" value={item.fields.smtpHost} />
              <FieldRow label="SMTP port" value={String(item.fields.smtpPort)} />
              <FieldRow label="SMTP security" value={item.fields.smtpSecurity} />
              <FieldRow label="Username" value={item.fields.username} />
            </div>
          </CardParts.Body>
        </Card>
      ))}
    </section>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[116px_minmax(0,1fr)_auto] items-center gap-2 rounded-token border border-subtle bg-surface-base px-3 py-2">
      <span className="text-xs text-tertiary">{label}</span>
      <code className="min-w-0 truncate font-mono text-xs text-primary">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <Button variant="ghost" size="sm" className="min-h-[32px] px-2" onClick={() => void copy()}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
