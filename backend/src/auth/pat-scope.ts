/**
 * PAT scope + expiry decision logic (pure, injectable-clock, never throws).
 *
 * Email-Ops PATs today are all-powerful and never expire. This module is the
 * PURE gate for the scoped/expiring model: every MCP tool / route declares one
 * REQUIRED scope string, and a PAT carries the scopes it holds plus an optional
 * expiry. The auth guard (and a Prisma migration adding `scopes`/`expiresAt`)
 * wire this in; here we only decide.
 */

/** The canonical scope vocabulary. A PAT may also hold `*` or a `prefix:*` wildcard. */
export const KNOWN_SCOPES = [
  'mail:read',
  'mail:write',
  'agent-inbox:read',
  'agent-inbox:approve',
  'cleaner:run',
  'admin:provision',
  'ui:control',
] as const;
export type PatScope = (typeof KNOWN_SCOPES)[number];

export interface PatRecord {
  /** Scope strings the token holds (may include `*` / `prefix:*` wildcards). */
  scopes: string[];
  /** ISO expiry; null = never expires. */
  expiresAt: string | null;
  /** ISO revocation stamp; null = active. */
  revokedAt: string | null;
}

export type PatDenyReason = 'revoked' | 'expired' | 'missing-scope';
export interface PatCheck {
  ok: boolean;
  reason?: PatDenyReason;
}

/**
 * True if `held` (a token's scope strings) satisfies the single `required`
 * scope. Supports `*` (all) and prefix wildcards like `mail:*` (matches
 * `mail:read`, `mail:write`). Case-sensitive. Prefix wildcards match only on the
 * `:` segment boundary — `mail:*` does NOT match `mailish:read`. Malformed /
 * unknown held entries are ignored (never grant). Never throws.
 */
export function scopeSatisfies(held: string[], required: string): boolean {
  if (!Array.isArray(held) || typeof required !== 'string' || required.length === 0) {
    return false;
  }
  for (const raw of held) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    // Full wildcard grants everything.
    if (raw === '*') return true;
    // Exact match.
    if (raw === required) return true;
    // Prefix wildcard: `prefix:*` matches `prefix:<anything>`, on the boundary.
    if (raw.endsWith(':*')) {
      const prefix = raw.slice(0, -1); // keep the trailing ':' → 'mail:'
      if (required.startsWith(prefix) && required.length > prefix.length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Full gate: revoked → deny, else expired (`expiresAt` strictly before
 * `nowIso`) → deny, else the scope check. Precedence is revoked > expired >
 * missing-scope. `nowIso` is injected so the decision is pure/testable. A null
 * `expiresAt` never expires. Never throws.
 */
export function checkPat(pat: PatRecord, required: string, nowIso: string): PatCheck {
  if (pat.revokedAt != null) {
    return { ok: false, reason: 'revoked' };
  }
  if (pat.expiresAt != null && pat.expiresAt < nowIso) {
    return { ok: false, reason: 'expired' };
  }
  if (!scopeSatisfies(pat.scopes, required)) {
    return { ok: false, reason: 'missing-scope' };
  }
  return { ok: true };
}
