/**
 * Provisioning RBAC — the pure "may this caller do this provisioning action?"
 * decision, driven by the per-workspace ProvisioningPolicy dials.
 *
 * Each action (create/edit a human mailbox, an agent mailbox = a send identity,
 * or an agent) has a ProvisioningMode dial:
 *   OPEN       → any member.
 *   MANAGER    → MANAGER+.
 *   ADMIN_ONLY → ADMIN+.
 *   APPROVAL   → a member may REQUEST (an approver applies); an approver-rung
 *                caller may act directly.
 * A self-service escape hatch lets a member create their OWN human mailbox when
 * the workspace allows it. Conservative like autonomy.ts — only ever gates, and
 * the DEFAULT policy (Balanced) applies when no row is written (feature inert).
 * Pure; no Nest/Prisma runtime deps. Mirrors the role ladder via role-rank.
 */

import { ProvisioningMode, WorkspaceRole } from '@prisma/client';
import { roleAtLeast } from '../common/workspace/role-rank';

/** The dials the decision reads (a subset of the ProvisioningPolicy row). */
export interface ProvisioningPolicyShape {
  humanMailboxCreateMode: ProvisioningMode;
  humanMailboxEditMode: ProvisioningMode;
  agentMailboxCreateMode: ProvisioningMode;
  agentMailboxEditMode: ProvisioningMode;
  agentCreateMode: ProvisioningMode;
  agentEditMode: ProvisioningMode;
  approverMinRole: WorkspaceRole;
  allowSelfServiceOwnMailbox: boolean;
}

/**
 * The "Balanced" default (the founder's pick): managers run day-to-day, IT/admin
 * owns agent send-identities, admin approves exceptions. Applied when a workspace
 * has no ProvisioningPolicy row (the feature is inert until configured).
 */
export const DEFAULT_PROVISIONING_POLICY: ProvisioningPolicyShape = {
  humanMailboxCreateMode: ProvisioningMode.MANAGER,
  humanMailboxEditMode: ProvisioningMode.MANAGER,
  agentMailboxCreateMode: ProvisioningMode.ADMIN_ONLY,
  agentMailboxEditMode: ProvisioningMode.ADMIN_ONLY,
  agentCreateMode: ProvisioningMode.MANAGER,
  agentEditMode: ProvisioningMode.MANAGER,
  approverMinRole: WorkspaceRole.ADMIN,
  allowSelfServiceOwnMailbox: false,
};

export type ProvisionDecision = 'allow' | 'deny' | 'requires_approval';

/**
 * Decide whether `callerRole` may perform a provisioning action under `mode`.
 * `isSelfOwnMailbox` + the policy's self-service flag open the escape hatch for a
 * member creating their own human mailbox.
 */
export function decideProvision(args: {
  mode: ProvisioningMode;
  callerRole: WorkspaceRole;
  approverMinRole: WorkspaceRole;
  isSelfOwnMailbox?: boolean;
  allowSelfServiceOwnMailbox?: boolean;
}): ProvisionDecision {
  const { mode, callerRole, approverMinRole, isSelfOwnMailbox, allowSelfServiceOwnMailbox } = args;

  // Self-service: a member may create their OWN human mailbox when allowed.
  if (isSelfOwnMailbox && allowSelfServiceOwnMailbox && roleAtLeast(callerRole, WorkspaceRole.MEMBER)) {
    return 'allow';
  }

  switch (mode) {
    case ProvisioningMode.OPEN:
      return roleAtLeast(callerRole, WorkspaceRole.MEMBER) ? 'allow' : 'deny';
    case ProvisioningMode.MANAGER:
      return roleAtLeast(callerRole, WorkspaceRole.MANAGER) ? 'allow' : 'deny';
    case ProvisioningMode.ADMIN_ONLY:
      return roleAtLeast(callerRole, WorkspaceRole.ADMIN) ? 'allow' : 'deny';
    case ProvisioningMode.APPROVAL:
      // An approver-rung caller acts directly; any other member files a request.
      if (roleAtLeast(callerRole, approverMinRole)) return 'allow';
      return roleAtLeast(callerRole, WorkspaceRole.MEMBER) ? 'requires_approval' : 'deny';
    default:
      return 'deny';
  }
}
