'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchProfile, getStoredUser, isAuthenticated, setStoredUser, type EmailOpsUser } from '@/lib/api';

/**
 * Resolve the signed-in user for the avatar/account menu.
 *
 * The stored session only holds the token (SSO stored `null` for the user), so
 * the avatar would fall back to initials. This hydrates the real profile (name +
 * Keycloak `picture`) once per load until we have an actual photo URL — a cached
 * null (from before the avatar existed, or a user with no photo) must not
 * permanently pin the fallback, and the `attempted` ref bounds it to a single
 * fetch so a still-empty picture never loops. Shared by every shell.
 */
export function useHydratedUser(): EmailOpsUser | null {
  const [user, setUser] = useState<EmailOpsUser | null>(() => getStoredUser<EmailOpsUser>());
  const attempted = useRef(false);
  useEffect(() => {
    if (attempted.current) return;
    if (user?.picture) return;
    if (!isAuthenticated()) return;
    attempted.current = true;
    let alive = true;
    fetchProfile() // authed by the HttpOnly cookie — no token needed
      .then((p) => {
        if (!alive) return;
        setStoredUser(p);
        setUser(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user?.picture]);
  return user;
}
