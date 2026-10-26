'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CardParts, Input, Skeleton } from '@/components/ui';
import {
  DEFAULT_EXPIRES_IN_DAYS,
  DEFAULT_PAT_SCOPES,
  MAX_EXPIRES_IN_DAYS,
  PAT_SCOPES,
  type PatScopeId,
  type PatListItem,
  type RememberedPatMeta,
  buildCreatePatBody,
  isCreatePatBody,
  redactSecrets,
  rowExpiresAt,
  rowScopes,
} from '@/lib/patForm';
import { createPat, listPats, revokePat } from '@/lib/patsApi';
import { CopyButton } from './CopyButton';

/**
 * Mint, list, and revoke API tokens for the signed-in user.
 * The plaintext is held only in `revealed` until the reader dismisses it.
 */
export function ApiTokensCard() {
  const [items, setItems] = useState<PatListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<Record<string, RememberedPatMeta>>({});
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<PatScopeId[]>(DEFAULT_PAT_SCOPES);
  const [expiresInDays, setExpiresInDays] = useState(String(DEFAULT_EXPIRES_IN_DAYS));
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await listPats();
      setItems(next);
    } catch (error) {
      setItems([]);
      setLoadError(redactSecrets(error instanceof Error ? error.message : 'Could not load tokens.'));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void listPats()
      .then((next) => {
        if (alive) setItems(next);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setItems([]);
        setLoadError(redactSecrets(error instanceof Error ? error.message : 'Could not load tokens.'));
      });
    return () => {
      alive = false;
    };
  }, []);

  function toggleScope(id: PatScopeId) {
    setScopes((current) =>
      current.includes(id) ? current.filter((scope) => scope !== id) : [...current, id],
    );
  }

  async function onCreate() {
    if (revealed) {
      setFormError('Save the token above before creating another.');
      return;
    }
    const parsedDays = /^\d+$/.test(expiresInDays.trim()) ? Number(expiresInDays.trim()) : Number.NaN;
    const body = buildCreatePatBody({ name, scopes, expiresInDays: parsedDays });
    if (!isCreatePatBody(body)) {
      setFormError(body.error);
      return;
    }
    setFormError(null);
    setCreating(true);
    try {
      const created = await createPat(body);
      if (!created.token) {
        setFormError('The server did not return a token. Nothing was copied.');
        return;
      }
      setRemembered((current) => ({
        ...current,
        [created.id]: {
          scopes: Array.isArray(created.scopes) ? created.scopes : body.scopes,
          expires_at: typeof created.expires_at === 'string' ? created.expires_at : null,
        },
      }));
      setRevealed({ token: created.token, name: created.name || body.name });
      setName('');
      setScopes(DEFAULT_PAT_SCOPES);
      setExpiresInDays(String(DEFAULT_EXPIRES_IN_DAYS));
      await load();
    } catch (error) {
      setFormError(redactSecrets(error instanceof Error ? error.message : 'Could not create the token.'));
    } finally {
      setCreating(false);
    }
  }

  function dismissReveal() {
    setRevealed(null);
  }

  async function onRevoke(id: string) {
    setRevokingId(id);
    setFormError(null);
    try {
      await revokePat(id);
      setConfirmId(null);
      await load();
    } catch (error) {
      setFormError(redactSecrets(error instanceof Error ? error.message : 'Could not revoke the token.'));
    } finally {
      setRevokingId(null);
    }
  }

  const sendEnabled = scopes.includes('mail:write');
  const ordered = [...(items ?? [])].sort((a, b) => {
    const aRevoked = a.revoked_at ? 1 : 0;
    const bRevoked = b.revoked_at ? 1 : 0;
    if (aRevoked !== bRevoked) return aRevoked - bRevoked;
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  });

  return (
    <Card id="api-tokens">
      <CardParts.Header>
        <div>
          <CardParts.Title className="text-base">API tokens</CardParts.Title>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-tertiary">
            A token lets an agent act as you until it expires or you revoke it. The value is shown
            once. A token cannot mint or revoke other tokens.
          </p>
        </div>
      </CardParts.Header>
      <CardParts.Body className="space-y-6">
        {revealed && (
          <div
            role="status"
            className="rounded-token border border-warning/40 bg-warning-subtle p-4"
          >
            <p className="text-sm font-semibold text-primary">
              Copy “{revealed.name}” now. It will not be shown again.
            </p>
            <textarea
              readOnly
              rows={3}
              value={revealed.token}
              aria-label="New API token"
              autoComplete="off"
              spellCheck={false}
              className="mt-3 block w-full resize-none rounded-token border border-border bg-surface-base p-3 font-mono text-xs leading-5 text-primary"
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton value={revealed.token} label="Copy token" />
              <Button type="button" size="sm" variant="secondary" onClick={dismissReveal}>
                I&rsquo;ve saved it
              </Button>
            </div>
          </div>
        )}

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Name</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                placeholder="Northwind reader"
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-tertiary">Expires in days</span>
              <Input
                inputMode="numeric"
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(event.target.value)}
                aria-describedby="pat-expiry-hint"
              />
            </label>
          </div>
          <p id="pat-expiry-hint" className="text-[11px] text-tertiary">
            Default {DEFAULT_EXPIRES_IN_DAYS} days. Maximum {MAX_EXPIRES_IN_DAYS}. A token always
            expires.
          </p>

          <fieldset className="space-y-2">
            <legend className="text-[11px] font-medium text-tertiary">Scopes</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {PAT_SCOPES.map((scope) => (
                <label
                  key={scope.id}
                  className="flex items-start gap-2 rounded-token border border-subtle bg-surface-base px-3 py-2 text-sm text-secondary"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={scopes.includes(scope.id)}
                    onChange={() => toggleScope(scope.id)}
                  />
                  <span>
                    <span className="block font-medium text-primary">{scope.label}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-tertiary">{scope.id}</span>
                    <span className="mt-0.5 block text-[12px] leading-5 text-tertiary">{scope.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {sendEnabled && (
            <p role="note" className="rounded-token border border-warning/40 bg-warning-subtle px-3 py-2 text-sm leading-6 text-secondary">
              mail:write lets an agent send mail. Leave it off unless you want that.
            </p>
          )}

          {formError && <p className="text-sm text-danger">{formError}</p>}

          <Button type="submit" size="sm" disabled={creating || revealed !== null}>
            {creating ? 'Creating…' : 'Create token'}
          </Button>
        </form>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-primary">Your tokens</h3>
          {items === null ? (
            <div className="space-y-2">
              <Skeleton h={52} />
              <Skeleton h={52} />
            </div>
          ) : loadError ? (
            <div className="space-y-2">
              <p className="text-sm text-danger">{loadError}</p>
              <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : ordered.length === 0 ? (
            <p className="text-sm text-tertiary">No API tokens yet.</p>
          ) : (
            <ul className="space-y-2">
              {ordered.map((item) => (
                <TokenRow
                  key={item.id}
                  item={item}
                  remembered={remembered[item.id]}
                  confirming={confirmId === item.id}
                  busy={revokingId === item.id}
                  onAsk={() => setConfirmId(item.id)}
                  onCancel={() => setConfirmId(null)}
                  onRevoke={() => void onRevoke(item.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </CardParts.Body>
    </Card>
  );
}

function TokenRow({
  item,
  remembered,
  confirming,
  busy,
  onAsk,
  onCancel,
  onRevoke,
}: {
  item: PatListItem;
  remembered?: RememberedPatMeta;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRevoke: () => void;
}) {
  const revoked = Boolean(item.revoked_at);
  const scopes = rowScopes(item, remembered);
  const expires = formatWhen(rowExpiresAt(item, remembered));
  const created = formatWhen(item.created_at);
  const lastUsed = item.last_used_at === undefined ? null : formatWhen(item.last_used_at);

  return (
    <li className="rounded-token border border-subtle bg-surface-base p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-primary">{item.name}</p>
            {revoked && <Badge variant="neutral">Revoked</Badge>}
          </div>
          {item.token_prefix && (
            <p className="mt-1 font-mono text-[11px] text-tertiary">{item.token_prefix}…</p>
          )}
          <dl className="mt-2 space-y-1 text-[12px] leading-5 text-tertiary">
            {scopes && (
              <div className="flex flex-wrap gap-1">
                {scopes.map((scope) => (
                  <Badge key={scope} variant="neutral">
                    {scope}
                  </Badge>
                ))}
              </div>
            )}
            {created && (
              <div>
                <dt className="inline">Created </dt>
                <dd className="inline text-secondary">{created}</dd>
              </div>
            )}
            {expires && (
              <div>
                <dt className="inline">Expires </dt>
                <dd className="inline text-secondary">{expires}</dd>
              </div>
            )}
            {lastUsed && (
              <div>
                <dt className="inline">Last used </dt>
                <dd className="inline text-secondary">{lastUsed}</dd>
              </div>
            )}
            {item.last_used_at === null && (
              <div>
                <dt className="inline">Last used </dt>
                <dd className="inline text-secondary">Never</dd>
              </div>
            )}
          </dl>
        </div>

        {!revoked && (
          <div className="shrink-0">
            {confirming ? (
              <div className="rounded-token border border-danger/30 bg-danger-subtle p-3">
                <p className="max-w-xs text-sm leading-5 text-secondary">
                  Revoke “{item.name}”? Anything using it loses access immediately.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="danger" disabled={busy} onClick={onRevoke}>
                    {busy ? 'Revoking…' : 'Revoke'}
                  </Button>
                  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" size="sm" variant="danger" onClick={onAsk}>
                Revoke
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}
