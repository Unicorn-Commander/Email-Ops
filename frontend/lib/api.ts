/**
 * Minimal browser API client for Email-Ops (Phase 1).
 *
 * The auth model mirrors the suite pattern: the backend owns the Keycloak OIDC
 * dance and issues a local session JWT, which the browser stores in localStorage
 * and sends as a Bearer token. This is intentionally tiny — the Phase 2 mailbox
 * cockpit + the agent-inbox approval UI replace it with a typed data layer.
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || '/api/v1';

const TOKEN_KEY = 'access_token';
const USER_KEY = 'user';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, user: unknown): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getStoredUser<T = unknown>(): T | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

/** The backend SSO entry point — redirects the browser to Keycloak. */
export function ssoLoginUrl(): string {
  return `${API_BASE}/auth/keycloak`;
}

/** Authenticated GET against the backend. Throws on non-2xx. */
export async function apiGet<T = unknown>(path: string, token?: string): Promise<T> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface EmailOpsUser {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
}

export interface MyWorkspace {
  workspace_id: string;
  slug: string;
  display_name: string;
  role: string;
  is_default: boolean;
}
