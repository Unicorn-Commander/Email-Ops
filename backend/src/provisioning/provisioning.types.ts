/**
 * Provisioning-policy wire shapes (the per-workspace RBAC control surface).
 */

import {
  ProvisionableKind,
  ProvisioningMode,
  ProvisioningRequestState,
  WorkspaceRole,
} from '@prisma/client';

export interface ProvisioningPolicyView {
  human_mailbox_create_mode: ProvisioningMode;
  human_mailbox_edit_mode: ProvisioningMode;
  agent_mailbox_create_mode: ProvisioningMode;
  agent_mailbox_edit_mode: ProvisioningMode;
  agent_create_mode: ProvisioningMode;
  agent_edit_mode: ProvisioningMode;
  approver_min_role: WorkspaceRole;
  allow_self_service_own_mailbox: boolean;
  max_mailboxes_per_workspace: number | null;
  max_agents_per_workspace: number | null;
  /** True when no row is written and the code DEFAULT (Balanced) applies. */
  is_default: boolean;
}

/** Patch input (service-level); undefined = unchanged. */
export interface UpdatePolicyInput {
  humanMailboxCreateMode?: ProvisioningMode;
  humanMailboxEditMode?: ProvisioningMode;
  agentMailboxCreateMode?: ProvisioningMode;
  agentMailboxEditMode?: ProvisioningMode;
  agentCreateMode?: ProvisioningMode;
  agentEditMode?: ProvisioningMode;
  approverMinRole?: WorkspaceRole;
  allowSelfServiceOwnMailbox?: boolean;
  maxMailboxesPerWorkspace?: number | null;
  maxAgentsPerWorkspace?: number | null;
}

/** Input to file a PENDING provisioning request (payload = the canonical service input). */
export interface FileRequestInput {
  kind: ProvisionableKind | string;
  action: string;
  payload: unknown;
  summary: string;
  requestedByAgentKey?: string | null;
}

/** The thin view returned when a request is filed (a 202-style ack). */
export interface FiledRequestView {
  id: string;
  state: ProvisioningRequestState;
  summary: string | null;
  kind: ProvisionableKind;
  action: string;
}

/** The full provisioning-request view (the approval queue surface). */
export interface ProvisioningRequestView {
  id: string;
  kind: ProvisionableKind;
  action: string;
  state: ProvisioningRequestState;
  summary: string | null;
  target_id: string | null;
  requested_by_uc_uid: string | null;
  requested_by_agent_key: string | null;
  reviewed_by_uc_uid: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  applied_ref_id: string | null;
  applied_at: string | null;
  failure_reason: string | null;
  created_at: string | null;
}

/** The provisioning actions the policy gates. */
export type ProvisionAction =
  | 'agent.create'
  | 'agent.edit'
  | 'humanMailbox.create'
  | 'humanMailbox.edit'
  | 'agentMailbox.create'
  | 'agentMailbox.edit';
