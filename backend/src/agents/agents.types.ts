/**
 * Agent-registry types (the "Agents" view + autonomy dial).
 *
 * `AgentView` is the snake_case wire projection the cockpit reads (mirroring the
 * AgentInboxView style). The *Input shapes are the service-level (camelCase)
 * inputs the controller maps the validated DTOs onto. The autonomy level is the
 * Prisma enum value verbatim ('L0_DRAFT_ONLY' | 'L1_APPROVE_TO_SEND' |
 * 'L2_AUTONOMOUS_AUDIT').
 */

import { AgentAutonomyLevel } from '@prisma/client';

/** The agent registry wire projection (snake_case). */
export interface AgentView {
  id: string;
  /** Stable provenance slug, unique per workspace ('customer-ops', ...). */
  key: string;
  display_name: string;
  description: string | null;
  /** Soft reference to the mailbox the agent sends from. */
  mailbox_account_id: string | null;
  /** Resolved address of that mailbox (for display); null when unset/unknown. */
  mailbox_address: string | null;
  autonomy_level: AgentAutonomyLevel;
  recipient_policy: Record<string, unknown> | null;
  active: boolean;
  /** How many of this agent's drafts are awaiting approval (by `key`). */
  pending_count: number;
  created_at: string | null;
  updated_at: string | null;
}

/** Create input (service-level). */
export interface CreateAgentInput {
  key: string;
  displayName: string;
  description?: string | null;
  mailboxAccountId?: string | null;
  autonomyLevel?: AgentAutonomyLevel;
  recipientPolicy?: Record<string, unknown> | null;
}

/**
 * Patch input (service-level). A field left `undefined` is unchanged; an explicit
 * `null` clears the (nullable) column. `recipientPolicy: null` clears the policy.
 */
export interface UpdateAgentInput {
  displayName?: string;
  description?: string | null;
  mailboxAccountId?: string | null;
  autonomyLevel?: AgentAutonomyLevel;
  recipientPolicy?: Record<string, unknown> | null;
  active?: boolean;
}
