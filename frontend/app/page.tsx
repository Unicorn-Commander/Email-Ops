// SPDX-FileCopyrightText: 2026 Magic Unicorn Unconventional Technology & Stuff Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE, isAuthenticated, clearSession } from '@/lib/api';
import { Skeleton } from '@/components/ui';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    // Public front door: the marketing landing is a self-contained static page
    // served from /public, outside the app shell. A hard navigation (not the SPA
    // router) loads it so its own document/styles fully take over.
    const toLanding = () => window.location.replace('/landing.html');

    // The bare root is the public landing, but explicit app entry and OIDC
    // callbacks must stay on the application side of the gate. Although the
    // current server-owned Email-Ops callback normally arrives at /api/v1,
    // preserve both response modes here so a Keycloak configuration change
    // cannot strand a successful login behind the marketing page.
    const query = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const hasOidcCallback =
      (query.has('code') && query.has('state')) ||
      (fragment.has('code') && fragment.has('state'));
    if (query.has('app') || hasOidcCallback) {
      window.location.replace(`/auth/login${window.location.search}${window.location.hash}`);
      return;
    }

    // No client-side marker at all → straight to the landing.
    if (!isAuthenticated()) {
      toLanding();
      return;
    }

    // A marker exists but may be stale: the HttpOnly session cookie can expire
    // while the localStorage marker lingers. Confirm with the server before
    // entering the app — a stale marker must never trap a returning visitor on
    // the login screen; send them to the public landing instead.
    let cancelled = false;
    fetch(`${API_BASE}/auth/me/workspaces`, { credentials: 'include' })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          router.replace('/dashboard');
        } else if (res.status === 401 || res.status === 403) {
          // Session is gone — clear the stale marker and show the front door,
          // not a bare login screen.
          clearSession();
          toLanding();
        } else {
          // Unexpected (5xx, etc.) — don't trap on login; show the landing but
          // keep the marker so a valid session still routes to the app later.
          toLanding();
        }
      })
      .catch(() => {
        // Network error — same: show the landing, keep the marker.
        if (!cancelled) toLanding();
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center bg-surface-base">
      <div className="w-full max-w-sm space-y-4 rounded-token-lg border border-subtle bg-surface-raised p-5">
        <Skeleton w={48} h={48} circle />
        <Skeleton w="70%" h={18} />
        <Skeleton w="92%" h={12} />
      </div>
    </div>
  );
}
