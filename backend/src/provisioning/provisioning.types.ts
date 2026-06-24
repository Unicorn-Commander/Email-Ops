/**
 * Provisioning-policy wire shapes (the per-workspace RBAC control surface).
 */

import { ProvisioningMode, WorkspaceRole } from '@prisma/client';

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

/** The provisioning actions the policy gates. */
export type ProvisionAction =
  | 'agent.create'
  | 'agent.edit'
  | 'humanMailbox.create'
  | 'humanMailbox.edit'
  | 'agentMailbox.create'
  | 'agentMailbox.edit';
