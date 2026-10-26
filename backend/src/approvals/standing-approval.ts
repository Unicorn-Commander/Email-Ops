import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  AgentSendKitDefinition,
  AgentSendKitMessage,
  agentSendKitBodyRegex,
  agentSendKitRefusalReason,
  buildAgentSendKitDefinition,
  recipientHash,
} from '../email/agent-send-kit';

export const MAX_STANDING_DAYS = 90;
export const DAY_MS = 86_400_000;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface RecipientRules {
  blockedDomains: string[];
  allowedDomains: string[];
}

// An explicit domain list is retained in the approved definition, so changes to
// a global provider list can never silently widen an existing approval.
export function recipientRules(raw: unknown): RecipientRules {
  const rules = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof rules !== 'object' ||
    Array.isArray(rules) ||
    Object.keys(rules).some((key) => !['blockedDomains', 'allowedDomains'].includes(key))
  ) {
    throw new BadRequestException('Recipient rules support blockedDomains and allowedDomains.');
  }
  const domains = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.length > 200 ||
      value.some(
        (v) =>
          typeof v !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(v),
      )
    ) {
      throw new BadRequestException('Recipient rules require lists of exact domain names.');
    }
    return [...new Set(value.map((v: string) => v.toLowerCase()))].sort();
  };
  return {
    blockedDomains: domains(rules.blockedDomains),
    allowedDomains: domains(rules.allowedDomains),
  };
}

export function standingTemplate(input: {
  bodyTemplate: string;
  subjects: string[];
  placeholderRules?: Record<string, string>;
  optionalLines?: number[];
}): AgentSendKitDefinition {
  try {
    const definition = buildAgentSendKitDefinition({
      ...input,
      recipients: ['preview@example.com'],
      fromAddress: 'preview@example.com',
      capPerDay: 1,
    });
    if (
      !definition.bodyTemplate.trim() ||
      definition.bodyTemplate.length > 100000 ||
      definition.subjects.length !== 1 ||
      definition.subjects.some((s) => typeof s !== 'string' || !s.trim() || s.length > 500)
    ) {
      throw new Error('A standing template needs one subject and a nonempty body.');
    }
    agentSendKitBodyRegex(definition);
    return definition;
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
}

/** Recipient-independent template identity, including all permitted personalization. */
export function standingTemplateSha256(definition: AgentSendKitDefinition): string {
  return sha256(
    JSON.stringify({
      bodyTemplate: definition.bodyTemplate,
      placeholderRules: definition.placeholderRules,
      optionalLines: definition.optionalLines,
      subjects: definition.subjects,
    }),
  );
}

export function assertStandingExpiry(expiresAt: Date, now = new Date()): void {
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt.getTime() > now.getTime() + MAX_STANDING_DAYS * DAY_MS
  ) {
    throw new BadRequestException('Expiry must be in the future and within 90 days.');
  }
}

export interface StandingRecord {
  id: string;
  workspaceId: string;
  campaignKey: string;
  mailboxId: string;
  fromAddress: string;
  templateSha256: string;
  bodyTemplate: string;
  placeholderRules: unknown;
  optionalLines: unknown;
  subjects: string[];
  recipientRules: unknown;
  capPerDay: number;
  expiresAt: Date;
  approvedAt: Date | null;
  revokedAt: Date | null;
}

export function standingRefusalReason(
  row: StandingRecord,
  message: AgentSendKitMessage & {
    mailboxAccountId: string | null;
    bodyHtml?: string | null;
  },
  usedToday: number,
  now = new Date(),
): string | null {
  if (!row.approvedAt) return 'not_approved';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt <= now) return 'expired';
  if (row.mailboxId !== message.mailboxAccountId) return 'sender_mismatch';
  // HTML has no approved template in this version. It must use the kit flow.
  if (message.bodyHtml) return 'html_not_approved';
  const to = message.toAddresses?.length ? message.toAddresses : [message.toAddress ?? ''];
  const address = to[0].trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return 'recipient_rule';
  try {
    const definition = standingTemplate({
      bodyTemplate: row.bodyTemplate,
      subjects: row.subjects,
      placeholderRules: row.placeholderRules as Record<string, string>,
      optionalLines: row.optionalLines as number[],
    });
    if (standingTemplateSha256(definition) !== row.templateSha256) return 'template_mismatch';
    const rules = recipientRules(row.recipientRules);
    const domain = address.split('@')[1];
    if (
      rules.blockedDomains.includes(domain) ||
      (rules.allowedDomains.length && !rules.allowedDomains.includes(domain))
    )
      return 'recipient_rule';
    return agentSendKitRefusalReason({
      message,
      now,
      sentToday: usedToday,
      kit: {
        ...definition,
        fromAddress: row.fromAddress,
        recipientHashes: [recipientHash(address)],
        capPerDay: row.capPerDay,
        expiresAt: row.expiresAt,
        state: 'APPROVED',
      },
    });
  } catch {
    return 'template_mismatch';
  }
}

export function standingBinding(row: StandingRecord) {
  const recipientSha256 = sha256(JSON.stringify(recipientRules(row.recipientRules)));
  return {
    recipientSha256,
    definitionSha256: sha256(
      JSON.stringify({
        campaignKey: row.campaignKey,
        mailboxId: row.mailboxId,
        fromAddress: row.fromAddress,
        templateSha256: row.templateSha256,
        recipientSha256,
        capPerDay: row.capPerDay,
        expiresAt: row.expiresAt.toISOString(),
      }),
    ),
  };
}
