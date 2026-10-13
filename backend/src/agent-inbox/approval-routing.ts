import { AgentInboxApprovalTier } from '@prisma/client';

/**
 * Conservative defaults for content that can change a commercial commitment.
 * Workspace JSON config can replace this list; numeric currency/percentage
 * matches remain enabled regardless of the configured keyword list.
 */
export const DEFAULT_APPROVAL_KEYWORDS = [
  'price',
  'pricing',
  'cost',
  'fee',
  'fees',
  'discount',
  'sale',
  'quote',
  'we commit to',
  'commitment',
  'committed',
  'contract',
  'agreement',
] as const;

export interface ApprovalClassification {
  tier: AgentInboxApprovalTier;
  matchedReason: string | null;
}

function configuredKeywords(value: unknown): string[] {
  const candidate = Array.isArray(value)
    ? value
    : value &&
        typeof value === 'object' &&
        Array.isArray((value as { keywords?: unknown }).keywords)
      ? (value as { keywords: unknown[] }).keywords
      : null;
  if (!candidate) return [...DEFAULT_APPROVAL_KEYWORDS];
  return candidate
    .filter((keyword): keyword is string => typeof keyword === 'string')
    .map((keyword) => keyword.trim().replace(/\s+/g, ' '))
    .filter((keyword) => keyword.length > 0 && keyword.length <= 100)
    .slice(0, 100);
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatch(text: string, keyword: string): string | null {
  const expression = keyword
    .split(' ')
    .map((part) => escaped(part))
    .join('\\s+');
  const match = new RegExp(`(^|[^a-z0-9])(${expression})(?=$|[^a-z0-9])`, 'i').exec(text);
  return match?.[2] ?? null;
}

/** Classify staged content without a model call or network dependency. */
export function classifyApprovalTier(
  subject: string | null | undefined,
  body: string | null | undefined,
  workspaceKeywords?: unknown,
): ApprovalClassification {
  const text = `${subject ?? ''}\n${body ?? ''}`;
  const currency =
    /(?:[$€£¥]\s*\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|dollars?|euros?|pounds?)\b)/i.exec(
      text,
    );
  if (currency) {
    return {
      tier: AgentInboxApprovalTier.OWNER_ADMIN,
      matchedReason: `currency amount: ${currency[0].trim()}`,
    };
  }

  const percentage = /\b\d+(?:\.\d+)?\s*%/.exec(text);
  if (percentage) {
    return {
      tier: AgentInboxApprovalTier.OWNER_ADMIN,
      matchedReason: `percentage: ${percentage[0].trim()}`,
    };
  }

  for (const keyword of configuredKeywords(workspaceKeywords).sort((a, b) => b.length - a.length)) {
    const match = keywordMatch(text, keyword);
    if (match) {
      return {
        tier: AgentInboxApprovalTier.OWNER_ADMIN,
        matchedReason: `keyword: ${match}`,
      };
    }
  }

  return { tier: AgentInboxApprovalTier.MAILBOX_OWNER, matchedReason: null };
}
