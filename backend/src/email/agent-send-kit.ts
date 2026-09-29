import { createHash } from 'crypto';
import { normalizeAddress } from './autonomy';

export const DEFAULT_PLACEHOLDER_RULES = {
  first_name: String.raw`[\p{L}][\p{L}' .-]{0,39}`,
  token: '[0-9a-f]{16}',
} as const;

export const AGENT_SEND_KIT_REFUSAL_REASONS = [
  'kit_missing',
  'kit_not_approved',
  'kit_rejected',
  'kit_expired',
  'from_mismatch',
  'extra_recipients',
  'attachments_not_allowed',
  'recipient_not_in_kit',
  'subject_not_in_kit',
  'body_mismatch',
  'cap_reached',
] as const;

export type AgentSendKitRefusalReason = (typeof AGENT_SEND_KIT_REFUSAL_REASONS)[number];

export interface AgentSendKitDefinitionInput {
  bodyTemplate: string;
  placeholderRules?: Record<string, string>;
  optionalLines?: number[];
  subjects: string[];
  recipients: string[];
  fromAddress: string;
  capPerDay: number;
}

export interface AgentSendKitDefinition {
  bodyTemplate: string;
  placeholderRules: Record<string, string>;
  optionalLines: number[];
  subjects: string[];
  recipients: string[];
  recipientHashes: string[];
  fromAddress: string;
  capPerDay: number;
}

export type AgentSendKitStateValue = 'PROPOSED' | 'APPROVED' | 'REJECTED';

export interface AgentSendKitRecord extends AgentSendKitDefinition {
  state?: AgentSendKitStateValue;
  expiresAt: Date;
}

export interface AgentSendKitMessage {
  fromAddress: string | null;
  toAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string | null;
  body: string | null;
  attachments: unknown;
}

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function plainTextBodySha256(body: string): string {
  return sha256Hex(body);
}

export function recipientHash(address: string): string {
  return sha256Hex(normalizeAddress(address));
}

export function normalizeCrLf(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function sortedRules(raw: Record<string, string> | undefined): Record<string, string> {
  const source = raw === undefined ? DEFAULT_PLACEHOLDER_RULES : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('placeholder_rules must be an object of name to regular-expression source.');
  }
  const entries = Object.entries(source).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const result: Record<string, string> = {};
  for (const [name, rule] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof rule !== 'string') {
      throw new Error('placeholder_rules contains an invalid entry.');
    }
    try {
      // Validate the source now so a human cannot approve a kit that can never
      // be evaluated by the agent approval guard.
      new RegExp(rule, 'u');
    } catch {
      throw new Error(`placeholder_rules.${name} is not a valid regular expression.`);
    }
    result[name] = rule;
  }
  return result;
}

function validateOptionalLines(bodyTemplate: string, optionalLines: number[]): void {
  const normalized = normalizeCrLf(bodyTemplate);
  const lines = normalized.split('\n');
  const seen = new Set<number>();
  for (const lineNumber of optionalLines) {
    if (!Number.isInteger(lineNumber) || lineNumber < 0 || seen.has(lineNumber)) {
      throw new Error('optional_lines must contain unique non-negative template line numbers.');
    }
    seen.add(lineNumber);
    if (lineNumber >= lines.length) {
      throw new Error('optional_lines contains a line outside body_template.');
    }
    const lineStart = lines.slice(0, lineNumber).reduce((total, line) => total + line.length + 1, 0);
    if (!normalized.slice(lineStart + lines[lineNumber].length).startsWith('\n\n')) {
      throw new Error('Each optional line must be followed by one blank line.');
    }
    if (seen.has(lineNumber + 1)) {
      throw new Error('optional_lines cannot include the blank line after another optional line.');
    }
  }
}

export function buildAgentSendKitDefinition(input: AgentSendKitDefinitionInput): AgentSendKitDefinition {
  if (typeof input.bodyTemplate !== 'string') throw new Error('body_template is required.');
  if (!Array.isArray(input.subjects) || input.subjects.length === 0) {
    throw new Error('subjects must contain at least one subject.');
  }
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new Error('recipients must contain at least one address.');
  }
  if (!input.fromAddress || !input.fromAddress.trim()) throw new Error('from_address is required.');
  if (!Number.isInteger(input.capPerDay) || input.capPerDay < 0) {
    throw new Error('cap_per_day must be a non-negative integer.');
  }
  const optionalLines = input.optionalLines ? [...input.optionalLines] : [];
  const placeholderRules = sortedRules(input.placeholderRules);
  validateOptionalLines(input.bodyTemplate, optionalLines);
  const recipients = input.recipients.map((address) => {
    if (typeof address !== 'string' || !normalizeAddress(address)) {
      throw new Error('recipients must contain non-empty addresses.');
    }
    return normalizeAddress(address);
  });
  return {
    bodyTemplate: input.bodyTemplate,
    placeholderRules,
    optionalLines,
    subjects: [...input.subjects],
    recipients,
    recipientHashes: recipients.map(recipientHash).sort(),
    fromAddress: input.fromAddress.trim(),
    capPerDay: input.capPerDay,
  };
}

/** The fixed-property-order JSON bound to a human's approval. */
export function agentSendKitTemplateSha256(definition: AgentSendKitDefinition): string {
  return sha256Hex(
    JSON.stringify({
      bodyTemplate: definition.bodyTemplate,
      placeholderRules: definition.placeholderRules,
      optionalLines: definition.optionalLines,
      subjects: definition.subjects,
      recipientHashes: [...definition.recipientHashes].sort(),
      fromAddress: definition.fromAddress,
      capPerDay: definition.capPerDay,
    }),
  );
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateFragment(value: string, rules: Record<string, string>): string {
  let cursor = 0;
  let result = '';
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(value)) !== null) {
    result += escapeRegexLiteral(value.slice(cursor, match.index));
    const rule = rules[match[1]];
    if (rule === undefined) throw new Error(`No rule exists for placeholder ${match[1]}.`);
    result += `(?:${rule})`;
    cursor = match.index + match[0].length;
  }
  return result + escapeRegexLiteral(value.slice(cursor));
}

export function agentSendKitBodyRegex(definition: AgentSendKitDefinition): RegExp {
  const normalized = normalizeCrLf(definition.bodyTemplate);
  const lines = normalized.split('\n');
  validateOptionalLines(normalized, definition.optionalLines);
  const optional = new Set(definition.optionalLines);
  const parts: string[] = [];
  for (let line = 0; line < lines.length; ) {
    if (optional.has(line)) {
      parts.push(`(?:${templateFragment(lines[line], definition.placeholderRules)}\\n\\n)?`);
      line += 2;
      continue;
    }
    parts.push(templateFragment(lines[line], definition.placeholderRules));
    if (line < lines.length - 1) parts.push('\\n');
    line += 1;
  }
  // JS '$' also matches immediately before a final newline. The negative
  // lookahead makes the anchor truly absolute, including for an extra newline.
  return new RegExp(`^(?:${parts.join('')})$(?![\\s\\S])`, 'u');
}

export function agentSendKitBodyMatches(definition: AgentSendKitDefinition, body: string | null): boolean {
  if (body === null) return false;
  try {
    return agentSendKitBodyRegex(definition).test(normalizeCrLf(body));
  } catch {
    return false;
  }
}

function normalizedSubject(subject: string): string {
  return subject
    .trim()
    .replace(/^(?:fwd:|fw:|re:)\s*/i, '')
    .trim()
    .toLowerCase();
}

export interface AgentSendKitCheckInput {
  message: AgentSendKitMessage;
  kit: AgentSendKitRecord | null;
  sentToday: number;
  now?: Date;
}

export function agentSendKitRefusalReason(input: AgentSendKitCheckInput): AgentSendKitRefusalReason | null {
  const { message, kit } = input;
  if (!kit) return 'kit_missing';
  if (kit.state === 'REJECTED') return 'kit_rejected';
  if (kit.state !== undefined && kit.state !== 'APPROVED') return 'kit_not_approved';
  const now = input.now ?? new Date();
  if (!Number.isFinite(kit.expiresAt.getTime()) || kit.expiresAt <= now) return 'kit_expired';
  if (normalizeAddress(message.fromAddress ?? '') !== normalizeAddress(kit.fromAddress)) {
    return 'from_mismatch';
  }
  const to = message.toAddresses?.length ? message.toAddresses : message.toAddress ? [message.toAddress] : [];
  if (to.length !== 1 || message.ccAddresses.length !== 0 || message.bccAddresses.length !== 0) {
    return 'extra_recipients';
  }
  if (message.attachments !== null && message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length > 0)) {
    return 'attachments_not_allowed';
  }
  if (!kit.recipientHashes.includes(recipientHash(to[0]))) return 'recipient_not_in_kit';
  const subject = message.subject ?? '';
  if (!kit.subjects.some((allowed) => normalizedSubject(allowed) === normalizedSubject(subject))) {
    return 'subject_not_in_kit';
  }
  const definition: AgentSendKitDefinition = {
    bodyTemplate: kit.bodyTemplate,
    placeholderRules: kit.placeholderRules,
    optionalLines: kit.optionalLines,
    subjects: kit.subjects,
    recipients: kit.recipients,
    recipientHashes: kit.recipientHashes,
    fromAddress: kit.fromAddress,
    capPerDay: kit.capPerDay,
  };
  if (!agentSendKitBodyMatches(definition, message.body)) return 'body_mismatch';
  if (input.sentToday >= kit.capPerDay) return 'cap_reached';
  return null;
}
