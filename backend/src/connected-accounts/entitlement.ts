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
