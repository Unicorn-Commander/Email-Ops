'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { setSession, setStoredUser, fetchProfile } from '@/lib/api';
import { Skeleton } from '@/components/ui';

function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    // Back-compat: an older backend redirected with the JWT as `?token=`. If it's
    // there, keep the legacy localStorage flow.
    const token = params.get('token');
    if (token) {
      setSession(token, null);
      fetchProfile(token)
        .then((u) => setSession(token, u))
        .catch(() => {})
        .finally(() => router.replace('/dashboard'));
      return;
    }
    // Cookie flow: the backend already set the HttpOnly session cookie on the
    // callback. Hydrate the profile (authed by that cookie) as the client-side
    // "logged in" marker, then land on the dashboard. A failure means no valid
    // session — send them to login rather than a broken shell.
    fetchProfile()
      .then((u) => {
        setStoredUser(u);
        router.replace('/dashboard');
      })
      .catch(() => router.replace('/auth/login'));
  }, [params, router]);
  return (
    <div className="grid min-h-screen place-items-center bg-surface-base">
      <div className="w-full max-w-sm space-y-4 rounded-token-lg border border-subtle bg-surface-raised p-5">
        <Skeleton w={44} h={44} circle />
        <Skeleton w="55%" h={16} />
        <p className="text-sm text-tertiary">Signing you in...</p>
      </div>
    </div>
  );
}

export default function SsoCallback() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen place-items-center bg-surface-base">
          <Skeleton w={44} h={44} circle />
        </div>
      }
    >
      <Callback />
    </Suspense>
  );
}
