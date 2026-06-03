/**
 * SSO access list — single source of truth for "who can sign into Email-Ops at
 * all" + "what canonical suite role do they get on first JIT".
 *
 * Sourced from the `EMAIL_OPS_ACCESS_LIST` env var, parsed once at startup.
 * Format is comma-separated `email-or-pattern:role` pairs, where role is a
 * canonical suite WorkspaceRole (SUITE-IDENTITY §7 — Email-Ops is greenfield, so
 * there is no legacy app-role layer to map through):
 *
 *   EMAIL_OPS_ACCESS_LIST="
 *     aaron@magicunicorn.tech:OWNER,
 *     shafenkhan@users.noreply.github.com:OWNER,
 *     *@magicunicorn.tech:MEMBER
 *   "
 *
 * Resolution order:
 *   1. Exact email match wins.
 *   2. Domain wildcard (`*@domain.tld`) matches if no exact entry.
 *   3. If neither matches, the user is NOT authorized — JIT provisioning is
 *      rejected. This is the intentional gate (SUITE-IDENTITY §D5): a Keycloak
 *      account in the shared `uchub` realm does NOT by itself grant an Email-Ops
 *      account. The allow-list is a membership-SEEDING convenience, NOT "the
 *      tenant" — Membership is what gates workspace access.
 *
 * If the env var is unset, falls back to a minimal hard-coded map (Aaron +
 * Shafen as OWNER) so a misconfigured deploy doesn't lock everyone out — but
 * the resolved source is surfaced in the boot log so it's obvious.
 */

import { WorkspaceRole } from '@prisma/client';

export interface AccessResolution {
  allowed: boolean;
  role: WorkspaceRole;
  reason: string;
}

interface AccessRule {
  pattern: string;
  isDomain: boolean;
  domain: string | null;
  role: WorkspaceRole;
}

const VALID_ROLES = new Set<string>(Object.values(WorkspaceRole));

const LEGACY_FALLBACK: AccessRule[] = [
  { pattern: 'aaron@magicunicorn.tech', isDomain: false, domain: null, role: WorkspaceRole.OWNER },
  { pattern: 'shafenkhan@users.noreply.github.com', isDomain: false, domain: null, role: WorkspaceRole.OWNER },
];

let cachedRules: AccessRule[] | null = null;
let cachedSource: string | null = null;

function parseAccessList(raw: string): AccessRule[] {
  const rules: AccessRule[] = [];
  for (const tokenRaw of raw.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const [patternRaw, roleRaw] = token.split(':').map((s) => s?.trim());
    if (!patternRaw || !roleRaw) continue;
    const role = roleRaw.toUpperCase();
    if (!VALID_ROLES.has(role)) continue;
    const pattern = patternRaw.toLowerCase();
    const isDomain = pattern.startsWith('*@');
    rules.push({
      pattern,
      isDomain,
      domain: isDomain ? pattern.slice(2) : null,
      role: role as WorkspaceRole,
    });
  }
  return rules;
}

function getRules(): { rules: AccessRule[]; source: string } {
  if (cachedRules !== null && cachedSource !== null) {
    return { rules: cachedRules, source: cachedSource };
  }
  const raw = process.env.EMAIL_OPS_ACCESS_LIST?.trim();
  if (raw) {
    cachedRules = parseAccessList(raw);
    cachedSource = 'env:EMAIL_OPS_ACCESS_LIST';
  } else {
    cachedRules = LEGACY_FALLBACK;
    cachedSource = 'legacy fallback (EMAIL_OPS_ACCESS_LIST not set)';
  }
  return { rules: cachedRules, source: cachedSource };
}

/**
 * Test-only: clears the cached rules so a follow-up call re-reads
 * `process.env.EMAIL_OPS_ACCESS_LIST`. Production code should never call this —
 * the cache is intentional.
 */
export function __resetAccessListCacheForTests(): void {
  cachedRules = null;
  cachedSource = null;
}

/**
 * Resolve whether `email` is allowed to JIT-provision an Email-Ops account, and
 * what canonical suite role they should get.
 */
export function resolveUserAccess(email: string | null | undefined): AccessResolution {
  if (!email) {
    return { allowed: false, role: WorkspaceRole.VIEWER, reason: 'no email on Keycloak profile' };
  }
  const lower = email.toLowerCase();
  const { rules, source } = getRules();

  // Exact match wins
  const exact = rules.find((r) => !r.isDomain && r.pattern === lower);
  if (exact) {
    return {
      allowed: true,
      role: exact.role,
      reason: `exact match in ${source} → ${exact.role}`,
    };
  }

  // Domain wildcard fallback
  const at = lower.indexOf('@');
  const domain = at >= 0 ? lower.slice(at + 1) : null;
  if (domain) {
    const wild = rules.find((r) => r.isDomain && r.domain === domain);
    if (wild) {
      return {
        allowed: true,
        role: wild.role,
        reason: `domain match (*@${domain}) in ${source} → ${wild.role}`,
      };
    }
  }

  return {
    allowed: false,
    role: WorkspaceRole.VIEWER,
    reason: `no rule in ${source} matched ${lower}`,
  };
}

/**
 * Inspect the resolved rule set — exposed for the boot-time log line.
 */
export function describeAccessList(): { source: string; ruleCount: number } {
  const { rules, source } = getRules();
  return { source, ruleCount: rules.length };
}
