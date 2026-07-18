import { MailRule } from '@prisma/client';
import { MatchNode, RuleAction } from './rule-engine';

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
