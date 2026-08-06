/**
 * Agent-registry types (the "Agents" view + autonomy dial + multi-mailbox + hierarchy).
 *
 * `AgentView` is the snake_case wire projection the cockpit reads. The *Input
 * shapes are the service-level (camelCase) inputs the controller maps the
 * validated DTOs onto.
 */

import { AgentAutonomyLevel, AgentTier, MailboxAccessLevel } from '@prisma/client';

/** One mailbox an agent may act through (an AgentMailbox binding). */
export interface AgentMailboxView {
  mailbox_account_id: string;
  mailbox_address: string | null;
  access: MailboxAccessLevel;
  is_primary: boolean;
}

/** The agent registry wire projection (snake_case). */
export interface AgentView {
  id: string;
  /** Stable provenance slug, unique per workspace ('customer-ops', ...). */
  key: string;
  display_name: string;
  description: string | null;
  /**
   * Explicit avatar image URL (absolute or app-relative), null when unset —
   * renderers then fall back per the one resolution rule (agent-avatar.ts):
   * /agent-avatars/<key>.svg when shipped, else /agent-avatars/default.svg.
   */
  avatar_url: string | null;
  /** The PRIMARY send mailbox (the isPrimary binding's mailbox; a cache). */
  mailbox_account_id: string | null;
  mailbox_address: string | null;
  /** Every mailbox this agent may act through (multi-mailbox). */
  mailboxes: AgentMailboxView[];
  autonomy_level: AgentAutonomyLevel;
  recipient_policy: Record<string, unknown> | null;
  /** Org-chart hierarchy (Brigade-federated identity). */
  tier: AgentTier;
  manager_agent_key: string | null;
  /** Per-agent kill switch (distinct from the workspace-wide pause). */
  paused: boolean;
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
  avatarUrl?: string | null;
  mailboxAccountId?: string | null;
  autonomyLevel?: AgentAutonomyLevel;
  recipientPolicy?: Record<string, unknown> | null;
  tier?: AgentTier;
  managerAgentKey?: string | null;
}

/**
 * Patch input (service-level). A field left `undefined` is unchanged; an explicit
 * `null` clears the (nullable) column. `recipientPolicy: null` clears the policy.
 */
export interface UpdateAgentInput {
  displayName?: string;
  description?: string | null;
  avatarUrl?: string | null;
  mailboxAccountId?: string | null;
  autonomyLevel?: AgentAutonomyLevel;
  recipientPolicy?: Record<string, unknown> | null;
  tier?: AgentTier;
  managerAgentKey?: string | null;
  paused?: boolean;
  active?: boolean;
}

/** Bind a mailbox to an agent (grant act-through access). */
export interface BindMailboxInput {
  mailboxAccountId: string;
  access?: MailboxAccessLevel;
  isPrimary?: boolean;
}
