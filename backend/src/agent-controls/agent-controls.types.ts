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
