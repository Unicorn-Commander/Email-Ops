import {
  cachedOrgEntitlementForSubject,
  emailOpsEntitlementFeatureKey,
  emailOpsEntitlementsEnabled,
  OrgEntitlement,
  OrgEntitlementsEnvGetter,
  resolveOrgEntitlement,
} from '../auth/org-entitlements.client';
import { entitlementsOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { normalizeSku, SKU_EMAIL_OPS } from '../email/entitlement';
import { SKU_EMAIL_OPS_MAILBOX } from './entitlement';

/** Numeric Ops-Center feature carrying the separately purchased James quota. */
export const EMAIL_OPS_MAILBOXES_FEATURE_KEY = 'email_ops_mailboxes';

/** Keep the derived-org cache short enough for a billing change to take effect. */
export const EFFECTIVE_ENTITLEMENTS_CACHE_TTL_MS = 5 * 60_000;

export interface EffectiveEntitlements {
  /** Canonical token SKUs plus the SKUs derived from the verified org snapshot. */
  entitlements: string[];
  /** Null means Ops-Center did not provide a numeric hosted-mailbox feature. */
  mailboxLimit: number | null;
  orgId: string | null;
}

export type EntitlementPrincipal = Partial<WithWorkspaceClaim> & {
  __entitlementBearer?: string | null;
  __patAuth?: unknown;
  __isFederationActor?: boolean;
  __isFederationAuth?: boolean;
};

export interface EffectiveEntitlementsOptions {
  /** Test seam or a caller that already has the verified realm bearer. */
  accessToken?: string;
  /** Current James/Stalwart mailbox count for the mailbox SKU decision. */
  currentHostedMailboxes?: number;
  getEnv?: OrgEntitlementsEnvGetter;
  now?: () => number;
  resolveOrgEntitlement?: typeof resolveOrgEntitlement;
  cachedOrgEntitlementForSubject?: typeof cachedOrgEntitlementForSubject;
}

interface CachedOrgSnapshot {
  snapshot: OrgEntitlement | null;
  expiresAt: number;
}

const effectiveCache = new Map<string, CachedOrgSnapshot>();

function normalizedFeatureKey(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '_');
}

function hasEmailOpsAccessFeature(
  entitlements: readonly string[],
  getEnv: OrgEntitlementsEnvGetter,
): boolean {
  const configured = normalizedFeatureKey(emailOpsEntitlementFeatureKey(getEnv));
  const accepted = new Set(
    [
      configured,
      'email_ops_access',
      'email_ops',
      'emailopsaccess',
      'emailops',
      'email-ops',
      'mail',
    ].map(normalizedFeatureKey),
  );
  return entitlements.some((entry) => accepted.has(normalizedFeatureKey(entry)));
}

/**
 * Parse the numeric feature form emitted by the current entitlements API seam.
 * Ops-Center currently returns feature keys as strings; a purchased count is
 * represented as `email_ops_mailboxes:<n>` (also accept `=`, `_`, or `-` for
 * compatibility with admin grants). A bare feature is deliberately ignored:
 * mailbox capacity must be numeric and never defaults open.
 */
export function mailboxLimitFromEntitlements(entitlements: readonly string[]): number | null {
  const prefix = normalizedFeatureKey(EMAIL_OPS_MAILBOXES_FEATURE_KEY);
  let limit: number | null = null;
  for (const entry of entitlements) {
    const normalized = normalizedFeatureKey(entry);
    const match = normalized.match(new RegExp(`^${prefix}(?::|=|_)(\\d+)$`));
    if (!match) continue;
    const parsed = Number(match[1]);
    if (!Number.isSafeInteger(parsed) || parsed < 0) continue;
    limit = limit === null ? parsed : Math.max(limit, parsed);
  }
  return limit;
}

function subjectOf(user: EntitlementPrincipal): string | undefined {
  const candidate = user.keycloakId ?? user.__ucUid;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function isNonHumanCredential(user: EntitlementPrincipal): boolean {
  return Boolean(user.__patAuth || user.__isFederationActor || user.__isFederationAuth);
}

function cacheKey(subject: string, workspaceId?: string): string {
  return `${subject}:${workspaceId?.trim() ?? ''}`;
}

function cachedSnapshot(key: string | null, nowMs: number): OrgEntitlement | null | undefined {
  if (!key) return undefined;
  const cached = effectiveCache.get(key);
  if (!cached || cached.expiresAt <= nowMs) {
    if (cached) effectiveCache.delete(key);
    return undefined;
  }
  return cached.snapshot;
}

function storeSnapshot(key: string | null, snapshot: OrgEntitlement | null, nowMs: number): void {
  if (!key) return;
  effectiveCache.set(key, {
    snapshot,
    expiresAt: nowMs + EFFECTIVE_ENTITLEMENTS_CACHE_TTL_MS,
  });
}

function claimSkus(user: EntitlementPrincipal): Set<string> {
  return new Set(
    entitlementsOf(user)
      .map(normalizeSku)
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Resolve token claims plus the caller's verified Ops-Center org features.
 *
 * No token claim, missing cache, malformed response, and endpoint failure all
 * retain the claim-only set. PATs and federation actors never consult the org
 * endpoint because they do not carry a human org context.
 */
export async function resolveEffectiveEntitlements(
  user: EntitlementPrincipal,
  workspaceId?: string,
  options: EffectiveEntitlementsOptions = {},
): Promise<EffectiveEntitlements> {
  const claims = claimSkus(user);
  const getEnv = options.getEnv ?? ((key: string) => process.env[key]);
  const now = options.now ?? Date.now;
  const currentHostedMailboxes = Math.max(0, options.currentHostedMailboxes ?? 0);

  if (!emailOpsEntitlementsEnabled(getEnv) || isNonHumanCredential(user)) {
    return { entitlements: [...claims], mailboxLimit: null, orgId: null };
  }

  const subject = subjectOf(user);
  const key = subject ? cacheKey(subject, workspaceId) : null;
  const nowMs = now();
  let snapshot = cachedSnapshot(key, nowMs);

  if (snapshot === undefined && subject) {
    const accessToken =
      options.accessToken ??
      (typeof user.__entitlementBearer === 'string' ? user.__entitlementBearer : undefined);
    if (accessToken?.trim()) {
      const resolve = options.resolveOrgEntitlement ?? resolveOrgEntitlement;
      try {
        snapshot = await resolve(accessToken, {
          subject,
          cache: true,
          requireFeature: false,
          getEnv,
          now,
        });
      } catch {
        // A resolver/client outage must never turn a claim-only caller into an
        // entitled caller. Keep the token claims and fail closed.
        snapshot = null;
      }
    } else {
      const readCached = options.cachedOrgEntitlementForSubject ?? cachedOrgEntitlementForSubject;
      snapshot = readCached(subject, now);
    }
    storeSnapshot(key, snapshot ?? null, nowMs);
  }

  const effective = new Set(claims);
  const mailboxLimit = snapshot ? mailboxLimitFromEntitlements(snapshot.entitlements) : null;
  if (snapshot && hasEmailOpsAccessFeature(snapshot.entitlements, getEnv)) {
    effective.add(SKU_EMAIL_OPS);
  }
  if (mailboxLimit !== null && currentHostedMailboxes < mailboxLimit) {
    effective.add(SKU_EMAIL_OPS_MAILBOX);
  }

  return {
    entitlements: [...effective],
    mailboxLimit,
    orgId: snapshot?.orgId ?? null,
  };
}

/** Convenience form for callers that only need the SKU array. */
export async function resolveEffectiveSkus(
  user: EntitlementPrincipal,
  workspaceId?: string,
  options: EffectiveEntitlementsOptions = {},
): Promise<string[]> {
  return (await resolveEffectiveEntitlements(user, workspaceId, options)).entitlements;
}

/** Test seam; the cache contains no bearer token. */
export function clearEffectiveEntitlementsCacheForTests(): void {
  effectiveCache.clear();
}
