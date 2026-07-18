export interface InboundMessage {
  fromAddress: string;
  /** Back-compat single recipient; prefer toAddresses when available. */
  toAddress: string;
  /** Every address on the message's REAL To header. When present, 'to'
   *  conditions match if ANY recipient satisfies the op (plus-address and
   *  list filtering need the actual header, not the mailbox's own address). */
  toAddresses?: string[];
  subject: string;
}

export type RuleActionType =
  | 'MOVE_TO_FOLDER'
  | 'LABEL'
  | 'ARCHIVE'
  | 'TRASH'
  | 'MARK_READ'
  | 'STOP';

export interface RuleAction {
  type: RuleActionType;
  value?: string;
}

export type MatchField = 'from' | 'to' | 'subject' | 'fromDomain';
export type MatchOp = 'equals' | 'contains' | 'startsWith' | 'endsWith';

export interface Condition {
  field: MatchField;
  op: MatchOp;
  value: string;
}

export interface MatchNode {
  all?: (Condition | MatchNode)[];
  any?: (Condition | MatchNode)[];
}

export interface CompiledRule {
  id: string;
  enabled: boolean;
  priority: number;
  match: MatchNode;
  actions: RuleAction[];
}

const ACTION_TYPES: readonly RuleActionType[] = [
  'MOVE_TO_FOLDER',
  'LABEL',
  'ARCHIVE',
  'TRASH',
  'MARK_READ',
  'STOP',
];

const MATCH_FIELDS: readonly MatchField[] = ['from', 'to', 'subject', 'fromDomain'];
const MATCH_OPS: readonly MatchOp[] = ['equals', 'contains', 'startsWith', 'endsWith'];

export function evaluateRules(rules: CompiledRule[], msg: InboundMessage): RuleAction[] {
  if (!Array.isArray(rules)) {
    return [];
  }

  const actions: RuleAction[] = [];

  const sortedRules = [...rules].sort((a, b) => {
    const aPriority = Number.isFinite(a?.priority) ? a.priority : Number.MAX_SAFE_INTEGER;
    const bPriority = Number.isFinite(b?.priority) ? b.priority : Number.MAX_SAFE_INTEGER;

    return aPriority - bPriority;
  });

  for (const rule of sortedRules) {
    if (!rule?.enabled) {
      continue;
    }

    if (!matchesNode(rule.match, msg)) {
      continue;
    }

    const ruleActions = parseActions(rule.actions);
    actions.push(...ruleActions);

    if (ruleActions.some((action) => action.type === 'STOP')) {
      break;
    }
  }

  return actions;
}

export function parseMatch(raw: unknown): MatchNode {
  const parsed = parseMatchNode(raw);

  return parsed ?? {};
}

export function parseActions(raw: unknown): RuleAction[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item): RuleAction[] => {
    if (!isRecord(item) || !isRuleActionType(item.type)) {
      return [];
    }

    const action: RuleAction = { type: item.type };

    if (typeof item.value === 'string') {
      action.value = item.value;
    }

    return [action];
  });
}

function matchesNode(raw: unknown, msg: InboundMessage): boolean {
  const node = parseMatchNode(raw);

  if (!node) {
    return false;
  }

  // Narrow node.all / node.any DIRECTLY (a boolean alias doesn't narrow under
  // the repo's strict tsconfig).
  if (Array.isArray(node.all)) {
    if (node.all.length === 0) {
      return false;
    }

    return node.all.every((child) => matchesChild(child, msg));
  }

  if (Array.isArray(node.any)) {
    if (node.any.length === 0) {
      return false;
    }

    return node.any.some((child) => matchesChild(child, msg));
  }

  return false;
}

function matchesChild(child: Condition | MatchNode, msg: InboundMessage): boolean {
  if (isCondition(child)) {
    return matchesCondition(child, msg);
  }

  return matchesNode(child, msg);
}

function matchesCondition(condition: Condition, msg: InboundMessage): boolean {
  const expected = condition.value.toLowerCase();

  // A field can be multi-valued ('to' = every real recipient); the condition
  // matches when ANY value satisfies the op.
  return readField(condition.field, msg).some((raw) => {
    const actual = raw.toLowerCase();
    switch (condition.op) {
      case 'equals':
        return actual === expected;
      case 'contains':
        return actual.includes(expected);
      case 'startsWith':
        return actual.startsWith(expected);
      case 'endsWith':
        return actual.endsWith(expected);
      default:
        return false;
    }
  });
}

function readField(field: MatchField, msg: InboundMessage): string[] {
  switch (field) {
    case 'from':
      return [typeof msg?.fromAddress === 'string' ? msg.fromAddress : ''];
    case 'to': {
      // Prefer the REAL To header (all recipients). An empty/missing list means
      // the header is unknown — a 'to' condition then matches NOTHING rather
      // than falsely matching against a stand-in address.
      const many = Array.isArray(msg?.toAddresses)
        ? msg.toAddresses.filter((a): a is string => typeof a === 'string' && a.length > 0)
        : [];
      if (many.length > 0) return many;
      return typeof msg?.toAddress === 'string' && msg.toAddress ? [msg.toAddress] : [];
    }
    case 'subject':
      return [typeof msg?.subject === 'string' ? msg.subject : ''];
    case 'fromDomain':
      return [extractDomain(typeof msg?.fromAddress === 'string' ? msg.fromAddress : '')];
    default:
      return [];
  }
}

function extractDomain(address: string): string {
  const atIndex = address.lastIndexOf('@');

  if (atIndex < 0 || atIndex === address.length - 1) {
    return '';
  }

  return address.slice(atIndex + 1);
}

function parseMatchNode(raw: unknown): MatchNode | null {
  if (!isRecord(raw)) {
    return null;
  }

  const node: MatchNode = {};

  if (Array.isArray(raw.all)) {
    node.all = raw.all.flatMap((child): (Condition | MatchNode)[] => {
      const parsed = parseMatchChild(child);

      return parsed ? [parsed] : [];
    });
  }

  if (Array.isArray(raw.any)) {
    node.any = raw.any.flatMap((child): (Condition | MatchNode)[] => {
      const parsed = parseMatchChild(child);

      return parsed ? [parsed] : [];
    });
  }

  if (!node.all && !node.any) {
    return null;
  }

  return node;
}

function parseMatchChild(raw: unknown): Condition | MatchNode | null {
  if (isCondition(raw)) {
    return raw;
  }

  return parseMatchNode(raw);
}

function isCondition(raw: unknown): raw is Condition {
  return (
    isRecord(raw) &&
    isMatchField(raw.field) &&
    isMatchOp(raw.op) &&
    typeof raw.value === 'string'
  );
}

function isRuleActionType(raw: unknown): raw is RuleActionType {
  return typeof raw === 'string' && ACTION_TYPES.includes(raw as RuleActionType);
}

function isMatchField(raw: unknown): raw is MatchField {
  return typeof raw === 'string' && MATCH_FIELDS.includes(raw as MatchField);
}

function isMatchOp(raw: unknown): raw is MatchOp {
  return typeof raw === 'string' && MATCH_OPS.includes(raw as MatchOp);
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}
