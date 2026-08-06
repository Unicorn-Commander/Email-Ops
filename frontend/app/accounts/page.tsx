'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import DOMPurify from 'dompurify';
import { Button, Badge, Card, Skeleton, cn } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { useConnectedAccounts } from '@/components/ConnectedAccountsProvider';
import { useInboxStats } from '@/components/useInboxStats';
import { RichTextEditor } from '@/components/mail/RichTextEditor';
import { formatBytes, providerMeta, storagePercent } from '@/lib/cleaner-model';
import {
  fetchProfile,
  getProviderLinkUrl,
  type ConnectedProvider,
  type LinkedAccountView,
} from '@/lib/api';
import {
  connectMailbox,
  createMailSignature,
  deleteMailSignature,
  getMailVacation,
  listMailMailboxes,
  listMailSignatures,
  setDefaultMailSignature,
  setMailVacation,
  updateMailSignature,
  type MailSignature,
  type MailboxPick,
} from '@/lib/mailApi';
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

      {workspaceId && <SignaturesSection workspaceId={workspaceId} />}
      {workspaceId && <VacationSection workspaceId={workspaceId} />}
    </div>
  );
}

function previewHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

function SignaturesSection({ workspaceId }: { workspaceId: string }) {
  const [mailboxes, setMailboxes] = useState<MailboxPick[]>([]);
  const [mailboxId, setMailboxId] = useState('');
  const [signatures, setSignatures] = useState<MailSignature[]>([]);
  const [selectedId, setSelectedId] = useState('new');
  const [name, setName] = useState('Default');
  const [html, setHtml] = useState('<p>Best,<br>Your name</p>');
  const [makeDefault, setMakeDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await listMailMailboxes(workspaceId);
        if (!alive) return;
        setMailboxes(res.items);
        setMailboxId((current) => current || res.items[0]?.id || '');
      } catch (e) {
        if (alive) setMessage(e instanceof Error ? e.message : 'Could not load mailboxes.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!mailboxId) return;
    let alive = true;
    void (async () => {
      try {
        const res = await listMailSignatures(workspaceId, mailboxId);
        if (!alive) return;
        setSignatures(res.items);
        const first = res.items[0];
        if (first) selectSignature(first, res.items);
        else newSignature(res.items.length);
      } catch (e) {
        if (alive) setMessage(e instanceof Error ? e.message : 'Could not load signatures.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, mailboxId]);

  function selectSignature(sig: MailSignature, all = signatures) {
    setSelectedId(sig.id);
    setName(sig.name);
    setHtml(sig.html);
    setMakeDefault(sig.is_default || all.length === 0);
    setMessage(null);
  }

  function newSignature(count = signatures.length) {
    setSelectedId('new');
    setName('Default');
    setHtml('<p>Best,<br>Your name</p>');
    setMakeDefault(count === 0);
    setMessage(null);
  }

  async function reload(nextSelectedId?: string) {
    if (!mailboxId) return;
    const res = await listMailSignatures(workspaceId, mailboxId);
    setSignatures(res.items);
    const next = res.items.find((s) => s.id === nextSelectedId) ?? res.items[0];
    if (next) selectSignature(next, res.items);
    else newSignature(0);
  }

  async function save() {
    if (!mailboxId || !name.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved =
        selectedId === 'new'
          ? await createMailSignature(workspaceId, mailboxId, {
              name: name.trim(),
              html,
              is_default: makeDefault,
            })
          : await updateMailSignature(workspaceId, mailboxId, selectedId, {
              name: name.trim(),
              html,
              is_default: makeDefault,
            });
      await reload(saved.id);
      setMessage('Signature saved.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save signature.');
    } finally {
      setBusy(false);
    }
  }

  async function makeSelectedDefault() {
    if (!mailboxId || selectedId === 'new') return;
    setBusy(true);
    try {
      const saved = await setDefaultMailSignature(workspaceId, mailboxId, selectedId);
      await reload(saved.id);
      setMessage('Default signature updated.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not set default signature.');
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    if (!mailboxId || selectedId === 'new') return;
    setBusy(true);
    try {
      await deleteMailSignature(workspaceId, mailboxId, selectedId);
      await reload();
      setMessage('Signature deleted.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not delete signature.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padded className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-primary">Signatures</h2>
          <p className="mt-1 text-sm text-tertiary">Compose defaults are scoped to each mailbox.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={mailboxId}
            onChange={(e) => setMailboxId(e.target.value)}
            className="rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary"
          >
            {mailboxes.map((mb) => (
              <option key={mb.id} value={mb.id}>
                {mb.email_address}
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={() => newSignature()} disabled={!mailboxId || busy}>
            New signature
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          {signatures.length === 0 ? (
            <p className="rounded-token border border-subtle bg-surface-base p-3 text-sm text-tertiary">
              No signatures for this mailbox yet.
            </p>
          ) : (
            signatures.map((sig) => (
              <button
                key={sig.id}
                type="button"
                onClick={() => selectSignature(sig)}
                className={cn(
                  'w-full rounded-token border px-3 py-2 text-left text-sm transition-colors',
                  selectedId === sig.id
                    ? 'border-accent bg-accent/10 text-primary'
                    : 'border-subtle bg-surface-base text-secondary hover:bg-surface-overlay',
                )}
              >
                <span className="block truncate font-medium">{sig.name}</span>
                {sig.is_default && <span className="text-[11px] text-tertiary">Default</span>}
              </button>
            ))
          )}
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="block w-full rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">HTML</span>
              <textarea
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                rows={8}
                className="block w-full resize-y rounded-token border border-border bg-surface-base px-3 py-2 font-mono text-xs text-primary"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-secondary">
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(e) => setMakeDefault(e.target.checked)}
              />
              Use as default for this mailbox
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void save()} disabled={busy || !mailboxId || !name.trim()}>
                {busy ? 'Saving...' : 'Save signature'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void makeSelectedDefault()}
                disabled={busy || selectedId === 'new'}
              >
                Set default
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void removeSelected()}
                disabled={busy || selectedId === 'new'}
              >
                Delete
              </Button>
            </div>
            {message && <p className="text-xs text-tertiary">{message}</p>}
          </div>

          <div className="rounded-token border border-subtle bg-surface-base p-4">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-tertiary">
              Live preview
            </p>
            <div
              className="prose prose-sm max-w-none text-primary"
              dangerouslySetInnerHTML={{ __html: previewHtml(html) }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

function VacationSection({ workspaceId }: { workspaceId: string }) {
  const [mailboxes, setMailboxes] = useState<MailboxPick[]>([]);
  const [mailboxId, setMailboxId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [subject, setSubject] = useState('Out of office');
  const [bodyHtml, setBodyHtml] = useState('<p>I am away and will reply when I return.</p>');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await listMailMailboxes(workspaceId);
        if (!alive) return;
        setMailboxes(res.items);
        setMailboxId((current) => current || res.items[0]?.id || '');
      } catch (e) {
        if (alive) setMessage(e instanceof Error ? e.message : 'Could not load mailboxes.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!mailboxId) return;
    let alive = true;
    void (async () => {
      try {
        const settings = await getMailVacation(workspaceId, mailboxId);
        if (!alive) return;
        if (!settings) {
          setEnabled(false);
          setSubject('Out of office');
          setBodyHtml('<p>I am away and will reply when I return.</p>');
          setStartsAt('');
          setEndsAt('');
          setMessage(null);
          return;
        }
        setEnabled(settings.enabled);
        setSubject(settings.subject);
        setBodyHtml(settings.body_html);
        setStartsAt(localInputValue(settings.starts_at));
        setEndsAt(localInputValue(settings.ends_at));
        setMessage(null);
      } catch (e) {
        if (alive) setMessage(e instanceof Error ? e.message : 'Could not load vacation settings.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, mailboxId]);

  async function save() {
    if (!mailboxId || !subject.trim()) return;
    const start = startsAt ? new Date(startsAt) : null;
    const end = endsAt ? new Date(endsAt) : null;
    if (start && end && start > end) {
      setMessage('Start time must be before end time.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const saved = await setMailVacation(workspaceId, mailboxId, {
        enabled,
        subject: subject.trim(),
        body_html: bodyHtml,
        starts_at: start ? start.toISOString() : null,
        ends_at: end ? end.toISOString() : null,
      });
      setEnabled(saved.enabled);
      setSubject(saved.subject);
      setBodyHtml(saved.body_html);
      setStartsAt(localInputValue(saved.starts_at));
      setEndsAt(localInputValue(saved.ends_at));
      setMessage('Vacation responder saved.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save vacation settings.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padded className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-primary">Out of Office</h2>
          <p className="mt-1 text-sm text-tertiary">
            Vacation responses are mailbox-scoped and mirrored to the mail engine when available.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={enabled ? 'success' : 'warning'} dot>
            {enabled ? 'Enabled' : 'Disabled'}
          </Badge>
          <select
            value={mailboxId}
            onChange={(e) => setMailboxId(e.target.value)}
            className="rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary"
          >
            {mailboxes.map((mb) => (
              <option key={mb.id} value={mb.id}>
                {mb.email_address}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          {mailboxes.map((mb) => (
            <button
              key={mb.id}
              type="button"
              onClick={() => setMailboxId(mb.id)}
              className={cn(
                'w-full rounded-token border px-3 py-2 text-left text-sm transition-colors',
                mailboxId === mb.id
                  ? 'border-accent bg-accent/10 text-primary'
                  : 'border-subtle bg-surface-base text-secondary hover:bg-surface-overlay',
              )}
            >
              <span className="block truncate font-medium">{mb.email_address}</span>
              <span className="text-[11px] text-tertiary">{enabled && mailboxId === mb.id ? 'Auto-reply on' : 'Auto-reply off'}</span>
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enable auto-reply
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-tertiary">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="block w-full rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary"
              maxLength={300}
            />
          </label>

          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Start</span>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="block w-full rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">End</span>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className="block w-full rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-tertiary">Message</span>
            <RichTextEditor
              value={bodyHtml}
              onChange={setBodyHtml}
              placeholder="Write the vacation auto-reply..."
              className="min-h-[200px]"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void save()} disabled={busy || !mailboxId || !subject.trim()}>
              {busy ? 'Saving...' : 'Save'}
            </Button>
          </div>

          {message && <p className="text-xs text-tertiary">{message}</p>}
        </div>
      </div>
    </Card>
  );
}

function localInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
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
          <Tooltip
            content={
              account.linked
                ? `Re-run the ${meta.shortLabel} sign-in to refresh the broker token — the fix when reading or analysis stops working. Deletes nothing.`
                : `Sign in with ${meta.shortLabel} via the identity broker and grant mail consent`
            }
            bubbleClassName="max-w-[300px]"
          >
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
          </Tooltip>
          <Tooltip content="Disconnect isn't available yet — unlink from your identity provider's security settings meanwhile">
            <span className="inline-flex">
              <Button variant="ghost" disabled>
                Disconnect
              </Button>
            </span>
          </Tooltip>
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
    <Tooltip
      content={
        state === 'on'
          ? 'Active — the linked broker token grants this access'
          : state === 'locked'
            ? 'Hard privacy rail: analysis reads headers and metadata only, never message bodies'
            : 'Not granted yet — link the account to enable this'
      }
    >
      <div className="rounded-token border border-subtle bg-surface-base p-3" tabIndex={0}>
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
    </Tooltip>
  );
}

/** Fetch a Keycloak account-link URL for the provider and send the browser there.
 *  The browser carries its KC SSO session cookie, links the IdP (granting the
 *  gmail.modify / Mail.ReadWrite consent), and returns to /accounts?linked=<provider>. */
async function linkProvider(provider: ConnectedProvider): Promise<void> {
  const { url } = await getProviderLinkUrl(provider);
  window.location.href = url;
}
