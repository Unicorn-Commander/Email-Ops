/**
 * The compose entitlement gate (server-side, defense-in-depth).
 *
 * BINDING: SENDING/DRAFTING outbound mail requires `email-ops`. It ADDITIONALLY
 * requires `customer-ops` only when the compose arrives through the CROSS-APP
 * seam (external_source = customer-ops) — which is all the "dual-SKU rule" ever
 * meant: one app reaching into another must hold both products. Demanding it of
 * a person sending their OWN mail made a standalone Email-Ops customer unable to
 * send at all. READS (list threads/messages) are viewer-level and require
 * neither. The bootstrap `UC_ENTITLEMENT_MODE=open` lets a compose run with a
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
 * Decide whether a caller may SEND/DRAFT: always requires email-ops, and
 * customer-ops as well for a cross-app compose. Honors the open bootstrap.
 * Pure (no I/O). Never throws.
 */
export function checkComposeEntitlement(
  entitlements: string[],
  workspaceId: string,
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
  externalSource?: string | null,
): EntitlementDecision {
  const have = new Set((entitlements ?? []).map(normalizeSku));
  const mode = entitlementMode(getEnv);

  // `email-ops` is ALWAYS required — it is the SKU for this product.
  const hasEmailOps = have.has(SKU_EMAIL_OPS);
  // `customer-ops` is required ONLY for the CROSS-APP trigger, which is what the
  // dual-SKU rule was always about: a Customer-Ops cockpit reaching through the
  // federation seam to send mail must hold BOTH products. It must NOT be
  // demanded of a person sending their own mail from their own mailbox —
  // requiring it there made a standalone Email-Ops customer, who never bought
  // Customer-Ops, unable to send at all. (Invisible until now only because
  // dogfood runs UC_ENTITLEMENT_MODE=open.)
  const crossApp = isCrossAppComposeSource(externalSource);
  const hasCustomerOps = have.has(SKU_CUSTOMER_OPS);

  if (hasEmailOps && (!crossApp || hasCustomerOps)) {
    return {
      allowed: true,
      mode,
      reason: crossApp
        ? 'entitled: cross-app compose, caller carries both customer-ops and email-ops'
        : 'entitled: caller carries email-ops (own-mailbox compose)',
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
    reason: !hasEmailOps
      ? 'not entitled: sending/drafting mail via Email-Ops requires the email-ops SKU.'
      : 'not entitled: a cross-app compose (via the Customer-Ops federation) requires ' +
        'BOTH customer-ops and email-ops; the caller does not carry customer-ops.',
  };
}

/**
 * Is this compose arriving through a CROSS-APP federation seam (rather than a
 * human using Email-Ops directly)? Only those pay the dual-SKU rule.
 *
 * Unknown/absent source is treated as FIRST-PARTY — the conservative choice for
 * BILLING (this gate meters entitlement, it is not the security boundary; the
 * anti-impersonation and mailbox-ownership fences are separate and unchanged).
 */
export function isCrossAppComposeSource(source?: string | null): boolean {
  const s = (source ?? '').trim().toLowerCase();
  if (!s) return false;
  return s.startsWith('customer-ops') || s.startsWith('customer_ops') || s === 'co';
}
