/**
 * Agent-controls wire shapes — the kill switch + the activity/audit feed.
 */

import { AgentActionKind } from '@prisma/client';

/** The workspace kill-switch state. */
export interface AgentControlsView {
  agents_paused: boolean;
}

/** One agent-mail action/audit row (snake_case wire). */
export interface AgentActivityView {
  id: string;
  kind: AgentActionKind;
  agent_key: string | null;
  message_id: string | null;
  actor_uc_uid: string | null;
  detail: string | null;
  created_at: string | null;
}

/**
 * Real, server-computed rail metrics for the agent command center — the honest
 * counterpart to the old client-side "Triaged" proxy (which merely counted
 * activity-feed volume). Every field is a genuine count over the RLS-fenced,
 * workspace-scoped tables (see AgentControlsService.getMetrics for the exact
 * signal each one reads).
 */
export interface AgentMetricsView {
  /**
   * Distinct threads an AGENT filed (set a folder disposition on) within the
   * window — the true "triaged by an agent" signal, read from
   * ThreadDisposition.setByAgentKey (one row per thread, so distinct by
   * construction). Human-only triage (setByAgentKey = null) is NOT counted.
   */
  triaged: number;
  /**
   * Real agent SENDS within the window: AUTONOMOUS_SEND (an L2 agent sending on
   * its own) + APPROVED (a staged draft a human approved, which then sent) rows
   * in the agent-action log.
   */
  sent: number;
  /**
   * CURRENT pending agent-inbox count (not windowed) — the same value the nav
   * badge shows: agent-drafted items still awaiting a human decision.
   */
  awaiting: number;
  /** The window these counts cover, in days (echoed for the caller). */
  window_days: number;
}
