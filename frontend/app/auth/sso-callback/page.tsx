'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { setSession } from '@/lib/api';

/**
 * SSO callback landing: the backend redirects here with `?token=…` after the
 * Keycloak OIDC dance. We persist the session and bounce to the agent inbox.
 */
function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const token = params.get('token');
    if (token) {
      setSession(token, null);
      router.replace('/agent-inbox');
    } else {
      router.replace('/auth/login');
    }
  }, [params, router]);
  return (
    <div className="eo-center">
      <div className="eo-spinner" />
      <p className="eo-muted">Signing you in…</p>
    </div>
  );
}

export default function SsoCallback() {
  return (
    <Suspense
      fallback={
        <div className="eo-center">
          <div className="eo-spinner" />
        </div>
      }
    >
      <Callback />
    </Suspense>
  );
}
