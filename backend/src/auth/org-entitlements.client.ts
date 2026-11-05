import { createHash } from 'node:crypto';

/** Fixed deadline for the user-scoped Ops-Center entitlement lookup. */
export const EMAIL_OPS_ENTITLEMENTS_TIMEOUT_MS = 5_000;

/** Feature key emitted by Ops-Center for an Email-Ops subscription. */
export const DEFAULT_EMAIL_OPS_ENTITLEMENT_FEATURE_KEY = 'email_ops_access';

export type OrgEntitlementsEnvGetter = (key: string) => string | undefined;

const defaultEnvGetter: OrgEntitlementsEnvGetter = (key) => process.env[key];

export interface OrgEntitlementsLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const consoleLogger: OrgEntitlementsLogger = {
  log: (message) => console.log(`[email-ops-entitlements] ${message}`),
  warn: (message) => console.warn(`[email-ops-entitlements] ${message}`),
  error: (message) => console.error(`[email-ops-entitlements] ${message}`),
};

/** The measured Ops-Center response, after snake_case is normalized. */
export interface OrgEntitlement {
  orgId: string;
  orgName: string | null;
  tier: string | null;
  role: string | null;
  entitlements: string[];
  /** Present for callers that want an explicit admission verdict. */
  allowed: true;
  entitled: true;
}

/** Alias retained for callers that use the reference client's terminology. */
export type OrgEntitlementResolution = OrgEntitlement;

export interface ResolveOrgEntitlementOptions {
  /** Verified Keycloak `sub`, used as part of the cache key. */
  subject?: string;
  /** Verified JWT `exp` in seconds, used to bound the cache entry. */
  exp?: number;
  /** Cache bearer verdicts; browser callbacks deliberately re-check. */
  cache?: boolean;
  getEnv?: OrgEntitlementsEnvGetter;
  logger?: OrgEntitlementsLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CachedResolution {
  resolution: OrgEntitlement | null;
  expiresAt: number;
}

const verdictCache = new Map<string, CachedResolution>();

export function ucEntitlementsUrl(
  getEnv: OrgEntitlementsEnvGetter = defaultEnvGetter,
): string | null {
  const raw = getEnv('UC_ENTITLEMENTS_URL');
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, '');
}

export function emailOpsEntitlementFeatureKey(
  getEnv: OrgEntitlementsEnvGetter = defaultEnvGetter,
): string {
  const raw = getEnv('EMAIL_OPS_ENTITLEMENT_FEATURE_KEY');
  return raw && raw.trim() ? raw.trim() : DEFAULT_EMAIL_OPS_ENTITLEMENT_FEATURE_KEY;
}

function truthy(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Armed only when the feature flag is on and the endpoint is configured. */
export function emailOpsEntitlementsEnabled(
  getEnv: OrgEntitlementsEnvGetter = defaultEnvGetter,
): boolean {
  return truthy(getEnv('EMAIL_OPS_ENTITLEMENTS_ENABLED')) && ucEntitlementsUrl(getEnv) !== null;
}

/** Parallel spelling for callers shared with the reference implementation. */
export const entitlementsEnabled = emailOpsEntitlementsEnabled;

function tokenExpirySeconds(accessToken: string): number | undefined {
  try {
    const encoded = accessToken.split('.')[1];
    if (!encoded) return undefined;
    const payload = JSON.parse(
      Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp
      : undefined;
  } catch {
    return undefined;
  }
}

function cacheKey(subject: string, accessToken: string): string {
  const digest = createHash('sha256').update(accessToken, 'utf8').digest('hex');
  return `${subject}:${digest}`;
}

function cacheTtlMs(exp: number | undefined, now: number): number {
  const max = 60_000;
  if (exp === undefined) return max;
  return Math.min(max, exp * 1000 - now);
}

function sweepCache(now: number): void {
  for (const [key, entry] of verdictCache) {
    if (entry.expiresAt <= now) verdictCache.delete(key);
  }
}

function featureKeys(featureKey: string): Set<string> {
  const normalized = featureKey.trim().toLowerCase();
  const keys = new Set<string>([
    normalized,
    normalized.replace(/_/g, '-'),
    normalized.replace(/-/g, '_'),
    normalized.replace(/[-_]/g, ''),
  ]);

  // Keep this in step with the aliases accepted by the compose gate. The
  // explicit *_access spelling is the Ops-Center payload shape.
  if (
    ['email_ops_access', 'email-ops-access', 'emailopsaccess', 'email_ops', 'email-ops'].includes(
      normalized,
    )
  ) {
    for (const alias of [
      'email_ops_access',
      'email-ops-access',
      'emailopsaccess',
      'email_ops',
      'email-ops',
      'emailops',
      'mail',
    ]) {
      keys.add(alias);
    }
  }
  return keys;
}

function cacheResolution(
  key: string | null,
  resolution: OrgEntitlement | null,
  exp: number | undefined,
  now: number,
): void {
  if (!key) return;
  const ttl = cacheTtlMs(exp, now);
  if (ttl > 0) verdictCache.set(key, { resolution, expiresAt: now + ttl });
}

/**
 * Resolve the caller's Email-Ops organization entitlement.
 *
 * Endpoint failures, malformed responses, and a valid response without the
 * configured feature all return null. This keeps AuthService's legacy access
 * list/invitation branches as the only admission path unless Ops-Center gives
 * a complete, entitled answer.
 */
export async function resolveOrgEntitlement(
  accessToken: string | undefined,
  subjectOrOptions?: string | ResolveOrgEntitlementOptions,
  maybeOptions?: ResolveOrgEntitlementOptions,
): Promise<OrgEntitlement | null> {
  const options: ResolveOrgEntitlementOptions =
    typeof subjectOrOptions === 'string'
      ? { ...(maybeOptions ?? {}), subject: subjectOrOptions }
      : (subjectOrOptions ?? {});
  const getEnv = options.getEnv ?? defaultEnvGetter;
  const logger = options.logger ?? consoleLogger;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const url = ucEntitlementsUrl(getEnv);

  if (!emailOpsEntitlementsEnabled(getEnv)) return null;
  if (!accessToken || !accessToken.trim()) {
    logger.warn('Email-Ops entitlement lookup skipped: no bearer token');
    return null;
  }
  if (!url) return null;

  const nowMs = now();
  const subject = options.subject?.trim();
  const shouldCache = options.cache === true && !!subject;
  const key = shouldCache ? cacheKey(subject!, accessToken) : null;
  sweepCache(nowMs);
  if (key) {
    const cached = verdictCache.get(key);
    if (cached && cached.expiresAt > nowMs) return cached.resolution;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_OPS_ENTITLEMENTS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    logger.warn('Email-Ops entitlement endpoint unavailable');
    cacheResolution(key, null, options.exp ?? tokenExpirySeconds(accessToken), nowMs);
    return null;
  }
  clearTimeout(timer);

  if (!response.ok) {
    logger.warn(`Email-Ops entitlement endpoint returned status ${response.status}`);
    cacheResolution(key, null, options.exp ?? tokenExpirySeconds(accessToken), nowMs);
    return null;
  }

  let body: any;
  try {
    body = await response.json();
  } catch {
    logger.warn('Email-Ops entitlement response was not JSON');
    cacheResolution(key, null, options.exp ?? tokenExpirySeconds(accessToken), nowMs);
    return null;
  }

  const orgId = typeof body?.org_id === 'string' && body.org_id.trim() ? body.org_id.trim() : null;
  const tier = typeof body?.tier === 'string' ? body.tier : null;
  const role = typeof body?.role === 'string' ? body.role : null;
  const orgName =
    typeof body?.org_name === 'string' && body.org_name.trim() ? body.org_name.trim() : null;
  const entitlements = Array.isArray(body?.entitlements)
    ? body.entitlements.every((entry: unknown) => typeof entry === 'string')
      ? body.entitlements.map((entry: string) => entry.trim()).filter(Boolean)
      : null
    : null;

  if (!orgId || !entitlements) {
    logger.warn('Email-Ops entitlement response had an invalid shape');
    cacheResolution(key, null, options.exp ?? tokenExpirySeconds(accessToken), nowMs);
    return null;
  }

  const acceptedKeys = featureKeys(emailOpsEntitlementFeatureKey(getEnv));
  const entitled = entitlements.some((entry) => acceptedKeys.has(entry.toLowerCase()));
  const resolution = entitled
    ? {
        orgId,
        orgName,
        tier,
        role,
        entitlements,
        allowed: true as const,
        entitled: true as const,
      }
    : null;

  logger.log(
    `Email-Ops entitlement decision: status=${response.status} ` +
      `orgPresent=${Boolean(orgId)} featurePresent=${entitled}`,
  );
  cacheResolution(key, resolution, options.exp ?? tokenExpirySeconds(accessToken), nowMs);
  return resolution;
}

/** Parallel spelling to the reference client's resolver. */
export const resolveEntitlement = resolveOrgEntitlement;

/** Test seam; cached entries contain no bearer token. */
export function clearOrgEntitlementCacheForTests(): void {
  verdictCache.clear();
}
