import { MailRule } from '@prisma/client';
import { MatchNode, RuleAction } from './rule-engine';

/**
 * The `match` JSON contract (mail_rules.match JSONB — backward-compatible
 * data, no migration; rule-engine.ts is the evaluator, MailRulesService the
 * write-side validator):
 *
 *   match := node
 *   node  := { all: child[] } | { any: child[] }     — exactly ONE mode per node on write
 *   child := { field, op, value }                    — leaf condition
 *          | node                                    — a nested GROUP (one level deep on write)
 *
 * - `{ all: [conditions] }` — every condition must hold. This is the original
 *   flat shape and keeps meaning ALL, unchanged.
 * - `{ any: [conditions] }` — at least one condition must hold.
 * - Grouped combinations: `{ all: [{ any: [...] }, { any: [...] }] }`
 *   (AND-of-ORs) or `{ any: [{ all: [...] }, ...] }` (OR-of-ANDs). Top-level
 *   children may mix conditions and groups.
 *
 * Write caps (create/PATCH, clear BadRequests in the service): ≤5 groups per
 * rule, ≤10 conditions per group and at the top level, groups contain only
 * conditions (no group-in-group), no empty groups, no node with both modes.
 *
 * Empty semantics (guard posture — a rule never accidentally matches every
 * message): an empty ALL matches NOTHING, an empty ANY matches NOTHING, `{}` /
 * malformed matches NOTHING. Stored legacy trees that exceed the write caps
 * (deeper nesting, both modes on one node) still EVALUATE: every clause
 * present must hold.
 */

/** Snake_case wire shape (same register as SnoozedThreadView). */
export interface MailRuleView {
  id: string;
  mailbox_id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: MatchNode;
  actions: RuleAction[];
  hit_count: number;
  last_hit_at: string | null;
  created_at: string;
  updated_at: string;
}

/** match/actions arrive as raw JSON bodies; the service is the validator. */
export interface CreateMailRuleInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  match: unknown;
  actions: unknown;
}

export interface UpdateMailRuleInput {
  name?: string;
  enabled?: boolean;
  priority?: number;
  match?: unknown;
  actions?: unknown;
}

/** The watcher's per-message shape handed to the applicator. */
export interface InboundRuleMessage {
  threadId: string;
  fromAddress: string | null;
  /** The message's REAL To recipients (from the JMAP poll). 'to' conditions
   *  evaluate against these; empty/absent = header unknown → 'to' matches
   *  nothing (never the mailbox's own address as a stand-in). */
  toAddresses?: string[];
  subject: string | null;
}

/** Tiny logging summary applyInbound returns (it NEVER throws). */
export interface ApplyInboundSummary {
  matched: number;
  applied: number;
}

/**
 * The columns the applicator needs from a mail_rules row — lets the watcher
 * preload one narrow cross-tenant SELECT per sweep and hand groups through.
 */
export type MailRuleRow = Pick<
  MailRule,
  'id' | 'workspaceId' | 'mailboxId' | 'enabled' | 'priority' | 'match' | 'actions'
>;
