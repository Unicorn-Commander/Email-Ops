/**
 * The compose entitlement gate (server-side, defense-in-depth).
 *
 * BINDING (mirrors the cockpit's EmailOpsPort gate): SENDING/DRAFTING outbound
 * mail via Email-Ops requires BOTH `customer-ops` AND `email-ops` in the
 * caller's entitlements — the dual-SKU rule the suite uses for a cross-app
 * trigger. READS (list threads/messages) are viewer-level and do NOT require the
 * dual SKU. The bootstrap `UC_ENTITLEMENT_MODE=open` lets a compose run with a
 * loud WARN before Lago emits the claim; anything else (incl. the default
 * `enforce`) is strict.
 *
 * Email-Ops re-derives this server-side even though the cockpit pre-checks: a
 * federated MCP call must never be able to bypass the entitlement boundary by
 * lying — the gate reads the entitlements off the cryptographically-verified
 * token (JwtStrategy.readEntitlements), never an HTTP header.
 */

import { Logger } from '@nestjs/common';

export const SKU_CUSTOMER_OPS = 'customer-ops';
export const SKU_EMAIL_OPS = 'email-ops';

/** SKU spelling/alias tolerance — accept whatever shape the upstream claim
 *  eventually lands. Normalized on read only (mirrors the AO/cockpit clients). */
const SKU_ALIASES: Record<string, string> = {
  'customer-ops': SKU_CUSTOMER_OPS,
  customer_ops: SKU_CUSTOMER_OPS,
  customerops: SKU_CUSTOMER_OPS,
  co: SKU_CUSTOMER_OPS,
  'email-ops': SKU_EMAIL_OPS,
  email_ops: SKU_EMAIL_OPS,
  emailops: SKU_EMAIL_OPS,
  mail: SKU_EMAIL_OPS,
};

export function normalizeSku(code: string): string {
  const key = (code || '').trim().toLowerCase();
  return SKU_ALIASES[key] ?? key;
}

export interface EntitlementDecision {
  allowed: boolean;
  mode: 'enforce' | 'open';
  reason: string;
}

/** Read the entitlement mode from env. UC_ENTITLEMENT_MODE wins, falling back to
 *  EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE; 'open' => bootstrap, else 'enforce'. */
export function entitlementMode(
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): 'enforce' | 'open' {
  const raw =
    getEnv('UC_ENTITLEMENT_MODE') ?? getEnv('EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE') ?? 'enforce';
  return raw.trim().toLowerCase() === 'open' ? 'open' : 'enforce';
}

const logger = new Logger('EmailOpsEntitlement');

/**
 * Decide whether a caller may SEND/DRAFT: requires BOTH customer-ops AND
 * email-ops, honoring the open bootstrap. Pure (no I/O). Never throws.
 */
export function checkComposeEntitlement(
  entitlements: string[],
  workspaceId: string,
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): EntitlementDecision {
  const have = new Set((entitlements ?? []).map(normalizeSku));
  const hasBoth = have.has(SKU_CUSTOMER_OPS) && have.has(SKU_EMAIL_OPS);
  const mode = entitlementMode(getEnv);

  if (hasBoth) {
    return {
      allowed: true,
      mode,
      reason: 'entitled: caller carries both customer-ops and email-ops',
    };
  }

  if (mode === 'open') {
    logger.warn(
      `Email-Ops compose entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — ` +
        `allowing an outbound mail compose for workspace=${workspaceId} WITHOUT the ` +
        `dual customer-ops+email-ops SKU check. Set the mode to 'enforce' once Lago ` +
        `emits entitlements.`,
    );
    return {
      allowed: true,
      mode,
      reason: 'open bootstrap: dual-SKU check bypassed (UC_ENTITLEMENT_MODE=open)',
    };
  }

  return {
    allowed: false,
    mode,
    reason:
      'not entitled: sending/drafting mail via Email-Ops requires BOTH customer-ops ' +
      'and email-ops; the caller does not carry both.',
  };
}
