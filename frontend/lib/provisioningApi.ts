/**
 * Typed browser client for the per-workspace provisioning policy (Phase 6).
 *
 * The provisioning policy is the workspace's governance for who may create/edit
 * mailboxes and agents, and the ceilings on how many of each can exist. Each
 * lever is a "mode" — OPEN (anyone), MANAGER, ADMIN_ONLY, or APPROVAL (gated
 * behind an approver of at least `approver_min_role`). Agent mailboxes are
 * higher-trust and default to ADMIN. A workspace with no explicit policy falls
 * back to the default (Balanced) policy, flagged `is_default`.
 *
 * This is the thin typed layer over `/workspaces/:wsId/provisioning-policy`
 * (GET + PUT). The PUT requires ADMIN (403 below it) — the page surfaces that
 * inline. Wire shape is snake_case and mirrors the backend ProvisioningPolicyView
 * exactly.
 */

import { apiGet, apiPut } from '@/lib/api';

/** How a create/edit lever is gated. */
export type ProvisioningMode = 'OPEN' | 'MANAGER' | 'ADMIN_ONLY' | 'APPROVAL';

/** The minimum workspace role an APPROVAL-mode approver must hold. */
export type ApproverRole = 'VIEWER' | 'MEMBER' | 'MANAGER' | 'ADMIN' | 'OWNER';

/** The workspace provisioning policy (mirrors ProvisioningPolicyView; snake_case). */
export interface ProvisioningPolicyView {
  human_mailbox_create_mode: ProvisioningMode;
  human_mailbox_edit_mode: ProvisioningMode;
  agent_mailbox_create_mode: ProvisioningMode;
  agent_mailbox_edit_mode: ProvisioningMode;
  agent_create_mode: ProvisioningMode;
  agent_edit_mode: ProvisioningMode;
  approver_min_role: ApproverRole;
  allow_self_service_own_mailbox: boolean;
  max_mailboxes_per_workspace: number | null;
  max_agents_per_workspace: number | null;
  is_default: boolean;
}

/** The editable subset of the policy (PUT body — the same fields). */
export interface ProvisioningPolicyPatch {
  human_mailbox_create_mode?: ProvisioningMode;
  human_mailbox_edit_mode?: ProvisioningMode;
  agent_mailbox_create_mode?: ProvisioningMode;
  agent_mailbox_edit_mode?: ProvisioningMode;
  agent_create_mode?: ProvisioningMode;
  agent_edit_mode?: ProvisioningMode;
  approver_min_role?: ApproverRole;
  allow_self_service_own_mailbox?: boolean;
  max_mailboxes_per_workspace?: number | null;
  max_agents_per_workspace?: number | null;
}

const policyPath = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/provisioning-policy`;

/** Read the workspace provisioning policy (falls back to the default policy). */
export async function getProvisioningPolicy(
  workspaceId: string,
  token?: string,
): Promise<ProvisioningPolicyView> {
  return apiGet<ProvisioningPolicyView>(policyPath(workspaceId), token);
}

/**
 * Replace the workspace provisioning policy (PUT — 403 below ADMIN, surfaced
 * inline via ApiError.status).
 */
export async function setProvisioningPolicy(
  workspaceId: string,
  patch: ProvisioningPolicyPatch,
  token?: string,
): Promise<ProvisioningPolicyView> {
  return apiPut<ProvisioningPolicyView>(policyPath(workspaceId), patch, token);
}
