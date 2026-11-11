'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../lib/api';
import { useActiveWorkspace } from '../ActiveWorkspaceProvider';
import { Button } from '../ui';

type Status = 'ok' | 'auth_failed' | 'tls_failed' | 'unreachable';
const copy: Record<Status, string> = {
  ok: 'Connection successful. INBOX is available.',
  auth_failed: 'Sign-in failed. Check your username, app password, and IMAP access setting.',
  tls_failed:
    'A secure TLS connection could not be established. Check the hostname and certificate.',
  unreachable: 'The IMAP inbox could not be reached. Check the hostname and try again.',
};

export function ExternalImapConnect({ onConnected }: { onConnected: () => void }) {
  const { activeWorkspaceId } = useActiveWorkspace();
  return activeWorkspaceId ? (
    <ImapConnectForm
      key={activeWorkspaceId}
      workspaceId={activeWorkspaceId}
      onConnected={() => {
        onConnected();
        window.dispatchEvent(
          new CustomEvent('external-imap:connected', { detail: activeWorkspaceId }),
        );
      }}
    />
  ) : null;
}

export function ImapConnectForm({
  workspaceId,
  onConnected,
}: {
  workspaceId: string;
  onConnected: () => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fields, setFields] = useState({ host: '', username: '', password: '', email_address: '' });
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/external-imap`;

  useEffect(() => {
    let disposed = false;
    void apiGet<{ enabled: boolean }>(`${path}/capabilities`)
      .then((result) => {
        if (!disposed) setEnabled(result.enabled === true);
      })
      .catch(() => {
        if (!disposed) setEnabled(false);
      });
    return () => {
      disposed = true;
    };
  }, [path]);

  async function submit(action: 'test' | 'connect') {
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiPost<{ status: Status; mailbox_id?: string }>(`${path}/${action}`, {
        ...fields,
        port: 993,
        security: 'tls',
      });
      // Never render arbitrary server errors or response text around credentials.
      setMessage(
        Object.prototype.hasOwnProperty.call(copy, result.status)
          ? copy[result.status]
          : copy.unreachable,
      );
      if (action === 'connect' && result.status === 'ok' && result.mailbox_id) {
        setFields({ host: '', username: '', password: '', email_address: '' });
        setOpen(false);
        onConnected();
      }
    } catch {
      setMessage('Could not complete the connection request. Check your session and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  return (
    <div className="flex flex-col gap-2 text-left">
      <Button variant="secondary" onClick={() => setOpen(!open)} disabled={busy}>
        Connect another provider (IMAP)
      </Button>
      {open && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit('connect');
          }}
        >
          <p className="text-xs text-tertiary">
            Read your INBOX and mark messages seen. Sending from this mailbox is not available yet.
          </p>
          {(
            [
              ['email_address', 'Mailbox email address', 'email'],
              ['host', 'IMAP hostname', 'text'],
              ['username', 'Username', 'text'],
              ['password', 'App password', 'password'],
            ] as const
          ).map(([key, label, type]) => (
            <label key={key} className="text-xs text-primary">
              {label}
              <input
                className="mt-1 w-full rounded border border-border bg-surface px-2 py-1"
                type={type}
                autoComplete={key === 'password' ? 'new-password' : 'off'}
                required
                maxLength={key === 'password' ? 1024 : key === 'host' ? 253 : 320}
                disabled={busy}
                value={fields[key]}
                onChange={(event) => {
                  setFields({ ...fields, [key]: event.target.value });
                  setMessage(null);
                }}
              />
            </label>
          ))}
          <label className="text-xs text-primary">
            Port (TLS only)
            <input
              className="mt-1 w-full rounded border border-border px-2 py-1"
              value="993"
              readOnly
            />
          </label>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || Object.values(fields).some((value) => !value)}
            onClick={() => void submit('test')}
          >
            Test connection
          </Button>
          <Button type="submit" disabled={busy}>
            Connect mailbox
          </Button>
        </form>
      )}
      {message && (
        <p role="status" className="text-xs text-tertiary">
          {message}
        </p>
      )}
    </div>
  );
}
