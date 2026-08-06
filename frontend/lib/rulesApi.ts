/**
 * Typed browser client for Email-Ops mail RULES ("file it before I see it").
 *
 * Rules are per-mailbox server-side filters: each carries a match tree
 * (conditions over from/to/subject/fromDomain), an ordered action list
 * (move / archive / trash / mark-read / stop), and a priority the engine
 * evaluates them in as mail arrives. This module mirrors the pinned REST
 * contract verbatim — snake_case wire shapes, no remapping — and reuses the
 * shared verb helpers from `@/lib/api` (API_BASE, credentials: 'include',
 * Bearer fallback, ApiError with status) for every call; it never edits that
 * file.
 */

import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

/** Message part a condition inspects. `fromDomain` = the sender's domain only. */
export type RuleField = 'from' | 'to' | 'subject' | 'fromDomain';

/** String comparison a condition applies. */
export type RuleOp = 'equals' | 'contains' | 'startsWith' | 'endsWith';

/** One leaf test: does `field` `op` `value`? */
export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
}

/** How a node combines its children: every one must hold, or at least one. */
export type RuleMatchMode = 'all' | 'any';

/**
 * A match-tree node: `all` = every child must match (AND), `any` = at least
 * one must (OR). Children are leaf conditions or ONE level of nested group
 * nodes (`{ all: [{ any: [...] }, …] }` = AND-of-ORs, and vice versa). The
 * server accepts exactly one mode per node on write, ≤5 groups per rule, and
 * ≤10 conditions per group; an empty clause matches NOTHING. The builder UI
 * EMITS the single-mode flat shape (`{ all: [conditions] }` or
 * `{ any: [conditions] }`); grouped shapes render as "advanced matching" and
 * are replaced wholesale when edited there.
 */
export interface MatchNode {
  all?: (RuleCondition | MatchNode)[];
  any?: (RuleCondition | MatchNode)[];
}

/** The action verbs a rule may apply. */
export type RuleActionType = 'MOVE_TO_FOLDER' | 'ARCHIVE' | 'TRASH' | 'MARK_READ' | 'STOP';

/**
 * One effect a matching rule applies, in list order. `MOVE_TO_FOLDER` carries
 * the target folder id in `value`. `STOP` halts lower-priority rules and is
 * NOT effectful on its own — the server rejects an actions list that is only
 * STOP. A `LABEL` type exists server-side but is REJECTED on write; this
 * client never emits it.
 */
export interface RuleAction {
  type: RuleActionType;
  value?: string;
}

/** One mail rule (mirrors the backend MailRuleView wire shape; snake_case). */
export interface MailRuleView {
  id: string;
  mailbox_id: string;
  name: string;
  enabled: boolean;
  /** Evaluation order — the list endpoint returns rules already sorted by it. */
  priority: number;
  match: MatchNode;
  actions: RuleAction[];
  /** How many messages this rule has acted on. */
  hit_count: number;
  last_hit_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Body for creating a rule. Omitted `enabled`/`priority` take server defaults. */
export interface CreateMailRuleBody {
  name: string;
  enabled?: boolean;
  priority?: number;
  match: MatchNode;
  actions: RuleAction[];
}

/** Partial body for updating a rule — send only the fields being changed. */
export type UpdateMailRuleBody = Partial<CreateMailRuleBody>;

export interface MailRulesResponse {
  rules: MailRuleView[];
}

/* Server-enforced limits, mirrored here so forms can validate inline. */
export const RULE_NAME_MAX = 120;
export const MAX_RULES_PER_MAILBOX = 100;
export const MAX_MATCH_GROUPS = 5;
export const MAX_MATCH_CONDITIONS_PER_GROUP = 10;

const seg = encodeURIComponent;

const rulesBase = (workspaceId: string, mailboxId: string) =>
  `/workspaces/${seg(workspaceId)}/mailboxes/${seg(mailboxId)}/rules`;

/** List a mailbox's rules, sorted by priority. */
export async function listMailRules(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<MailRulesResponse> {
  return apiGet<MailRulesResponse>(rulesBase(workspaceId, mailboxId), token);
}

/**
 * Create a rule. Server-side validation (mirror before calling): name 1..120
 * chars, `match` contains ≥1 condition, `actions` contains ≥1 effectful
 * action (STOP alone is invalid), and at most 100 rules per mailbox.
 */
export async function createMailRule(
  workspaceId: string,
  mailboxId: string,
  body: CreateMailRuleBody,
  token?: string,
): Promise<MailRuleView> {
  return apiPost<MailRuleView>(rulesBase(workspaceId, mailboxId), body, token);
}

/** Patch a rule (any of name / enabled / priority / match / actions). */
export async function updateMailRule(
  workspaceId: string,
  mailboxId: string,
  ruleId: string,
  body: UpdateMailRuleBody,
  token?: string,
): Promise<MailRuleView> {
  return apiPatch<MailRuleView>(`${rulesBase(workspaceId, mailboxId)}/${seg(ruleId)}`, body, token);
}

/** Delete a rule. Mail it already filed stays where it is. */
export async function deleteMailRule(
  workspaceId: string,
  mailboxId: string,
  ruleId: string,
  token?: string,
): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`${rulesBase(workspaceId, mailboxId)}/${seg(ruleId)}`, token);
}

/* ── Match-shape helpers (deserializing rules into the simple builder) ────── */

/** Narrow a match-tree child to a leaf condition (vs a nested node). */
export function isRuleCondition(node: RuleCondition | MatchNode): node is RuleCondition {
  const c = node as RuleCondition;
  return typeof c.field === 'string' && typeof c.op === 'string' && typeof c.value === 'string';
}

/** A match the simple builder can edit: ONE mode over flat leaf conditions. */
export interface SimpleMatch {
  mode: RuleMatchMode;
  conditions: RuleCondition[];
}

/**
 * Flatten a match tree into the single-mode condition list the builder edits,
 * or `null` when the tree doesn't fit that shape (nested groups, or a node
 * carrying both `all` and `any`) — the "advanced matching" case.
 */
export function flattenSimpleMatch(match: MatchNode): SimpleMatch | null {
  if (match.all && match.any) return null;
  const conditions: RuleCondition[] = [];
  for (const child of match.all ?? match.any ?? []) {
    if (!isRuleCondition(child)) return null;
    conditions.push(child);
  }
  return { mode: match.any ? 'any' : 'all', conditions };
}

/** Count the leaf conditions anywhere in a match tree (for summaries). */
export function countConditions(match: MatchNode): number {
  let n = 0;
  for (const child of [...(match.all ?? []), ...(match.any ?? [])]) {
    n += isRuleCondition(child) ? 1 : countConditions(child);
  }
  return n;
}
