import { Logger } from '@nestjs/common';
import { entitlementMode, normalizeSku, SKU_EMAIL_OPS } from '../email/entitlement';

export interface EntitlementDecision {
  allowed: boolean;
  mode: 'enforce' | 'open';
  reason: string;
}

const logger = new Logger('ConnectedAccountsEntitlement');
export const SKU_EMAIL_OPS_VAULT = 'email-ops:vault';

/**
 * Sovereign MAILBOX HOSTING add-on.
 *
 * Pricing shape (2026-08-11): the cleaner/agent layer (`email-ops`) is bundled
 * with the suite and sellable standalone — it costs inference and nothing else.
 * HOSTING a mailbox on our own James server is different: storage, sending
 * reputation, backups and a real support obligation all scale per mailbox, so
 * it is a separate, metered add-on rather than something a suite seat implies.
 *
 * ⚠️ This is a distinct SKU string, NOT a prefix of the base one:
 * `normalizeSku` maps aliases but does no prefix matching, so holding
 * `email-ops:mailbox` does not satisfy `email-ops` and vice-versa. A hosted
 * customer needs BOTH — same convention as `email-ops:vault`.
 */
export const SKU_EMAIL_OPS_MAILBOX = 'email-ops:mailbox';

/**
 * Gate PROVISIONING a sovereign (James-hosted) mailbox. Connecting an existing
 * Gmail/Microsoft account is NOT gated here — that is the bundled cleaner lane
 * and costs us no hosting.
 */
export function checkMailboxHostingEntitlement(
  entitlements: string[],
  workspaceId: string,
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): EntitlementDecision {
  const have = new Set((entitlements ?? []).map(normalizeSku));
  const mode = entitlementMode(getEnv);

  if (have.has(SKU_EMAIL_OPS_MAILBOX)) {
    return { allowed: true, mode, reason: 'entitled: caller carries email-ops:mailbox' };
  }

  if (mode === 'open') {
    logger.warn(
      `Mailbox-hosting entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — provisioning a ` +
        `hosted mailbox for workspace=${workspaceId} WITHOUT the email-ops:mailbox add-on.`,
    );
    return {
      allowed: true,
      mode,
      reason: 'open bootstrap: email-ops:mailbox check bypassed (UC_ENTITLEMENT_MODE=open)',
    };
  }

  return {
    allowed: false,
    mode,
    reason:
      'not entitled: hosting a mailbox on Email-Ops requires the email-ops:mailbox add-on. ' +
      'Connecting an existing Gmail or Outlook account does not — that is included.',
  };
}

/**
 * Cleaner-engine entitlement gate.
 *
 * Reads are viewer-level, but inbox stats / analysis require the `email-ops`
 * SKU. The open bootstrap mode emits a WARN and lets the call through until
 * Lago/entitlement claims are live.
 */
export function checkCleanerEntitlement(
  entitlements: string[],
  workspaceId: string,
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): EntitlementDecision {
  const have = new Set((entitlements ?? []).map(normalizeSku));
  const hasSku = have.has(SKU_EMAIL_OPS);
  const mode = entitlementMode(getEnv);

  if (hasSku) {
    return {
      allowed: true,
      mode,
      reason: 'entitled: caller carries email-ops',
    };
  }

  if (mode === 'open') {
    logger.warn(
      `Cleaner entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — allowing inbox stats / analysis for workspace=${workspaceId} WITHOUT the email-ops SKU. Set the mode to 'enforce' once entitlements are emitted.`,
    );
    return {
      allowed: true,
      mode,
      reason: 'open bootstrap: email-ops SKU check bypassed (UC_ENTITLEMENT_MODE=open)',
    };
  }

  return {
    allowed: false,
    mode,
    reason: 'not entitled: inbox stats / analysis require the email-ops SKU.',
  };
}

export function checkVaultEntitlement(
  entitlements: string[],
  workspaceId: string,
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): EntitlementDecision {
  const have = new Set((entitlements ?? []).map(normalizeSku));
  const hasSku = have.has(SKU_EMAIL_OPS_VAULT);
  const mode = entitlementMode(getEnv);

  if (hasSku) {
    return {
      allowed: true,
      mode,
      reason: 'entitled: caller carries email-ops:vault',
    };
  }

  if (mode === 'open') {
    logger.warn(
      `Vault entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — allowing retained archives for workspace=${workspaceId} WITHOUT the email-ops:vault SKU. Set the mode to 'enforce' once entitlements are emitted.`,
    );
    return {
      allowed: true,
      mode,
      reason: 'open bootstrap: email-ops:vault SKU check bypassed (UC_ENTITLEMENT_MODE=open)',
    };
  }

  return {
    allowed: false,
    mode,
    reason: 'not entitled: retained archives require the email-ops:vault SKU.',
  };
}
