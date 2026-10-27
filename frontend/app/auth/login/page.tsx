'use client';

import { FormEvent, useEffect, useState } from 'react';
import { approvalReturnPath } from '@/lib/approvalsApi';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  fetchLocalLoginEnabled,
  localLogin,
  setStoredUser,
  ssoLoginUrl,
} from '@/lib/api';
import { Badge, Button, Card, Input } from '@/components/ui';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchLocalLoginEnabled()
      .then(({ enabled }) => {
        if (mounted) setLocalEnabled(enabled === true);
      })
      .catch(() => {
        if (mounted) setLocalEnabled(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function submitLocalLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await localLogin(email, password);
      setStoredUser(result.user);
      router.replace(approvalReturnPath());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-surface-base px-4">
      <Card padded className="w-full max-w-md overflow-hidden">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-token-lg bg-accent text-sm font-semibold text-accent-contrast">
            EO
          </div>
          <div>
            <p className="text-sm font-semibold text-primary">Email-Ops</p>
            <p className="text-xs text-tertiary">Email-Ops</p>
          </div>
        </div>
        <Badge variant="protected">privacy-first</Badge>
        <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary">
          Sign in to your inbox.
        </h1>
        <p className="mt-3 text-sm leading-6 text-tertiary">
          Broker consent is explicit. The cockpit scans headers and metadata only until you review a
          plan.
        </p>
        <Button block className="mt-6" onClick={() => (window.location.href = ssoLoginUrl())}>
          Sign in with Unicorn Commander SSO
        </Button>
        {localEnabled ? (
          <>
            <div className="my-6 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-border" />
              <span>or self-host</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <form className="space-y-3" onSubmit={submitLocalLogin}>
              <label className="block text-sm text-secondary" htmlFor="local-email">
                Admin email
              </label>
              <Input
                id="local-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <label className="block text-sm text-secondary" htmlFor="local-password">
                Admin password
              </label>
              <Input
                id="local-password"
                type="password"
                autoComplete="current-password"
                required
                minLength={12}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {error ? <p className="text-sm text-danger">{error}</p> : null}
              <Button block type="submit" variant="secondary" disabled={pending}>
                {pending ? 'Signing in...' : 'Sign in with local admin'}
              </Button>
            </form>
          </>
        ) : null}
      </Card>
    </div>
  );
}
