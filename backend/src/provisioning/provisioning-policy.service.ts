/**
 * ProvisioningPolicyService — the per-workspace RBAC control surface + the gate.
 *
 * Owns the ProvisioningPolicy row (or the code DEFAULT when none is written —
 * the feature is inert until configured) and the one `authorize()` the write
 * surfaces call: load the effective policy, run the pure decideProvision, and
 * throw 403 on deny / return allow|requires_approval. Workspace-scoped via
 * withWorkspace.
 */

import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  AgentActionKind,
  Prisma,
  ProvisionableKind,
  ProvisioningMode,
  ProvisioningRequestState,
  WorkspaceRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_PROVISIONING_POLICY,
  decideProvision,
  ProvisionDecision,
} from './provisioning-policy';
import {
  FileRequestInput,
  FiledRequestView,
  ProvisionAction,
  ProvisioningPolicyView,
  UpdatePolicyInput,
} from './provisioning.types';

/** The effective policy = the 6 dials + approver + self-service + caps + origin. */
interface EffectivePolicy {
  humanMailboxCreateMode: ProvisioningMode;
  humanMailboxEditMode: ProvisioningMode;
  agentMailboxCreateMode: ProvisioningMode;
  agentMailboxEditMode: ProvisioningMode;
  agentCreateMode: ProvisioningMode;
  agentEditMode: ProvisioningMode;
  approverMinRole: WorkspaceRole;
  allowSelfServiceOwnMailbox: boolean;
  maxMailboxesPerWorkspace: number | null;
  maxAgentsPerWorkspace: number | null;
  isDefault: boolean;
}

const PATCH_KEYS: Array<keyof UpdatePolicyInput> = [
  'humanMailboxCreateMode',
  'humanMailboxEditMode',
  'agentMailboxCreateMode',
  'agentMailboxEditMode',
  'agentCreateMode',
  'agentEditMode',
  'approverMinRole',
  'allowSelfServiceOwnMailbox',
  'maxMailboxesPerWorkspace',
  'maxAgentsPerWorkspace',
];

@Injectable()
export class ProvisioningPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /** The effective policy for the workspace (the row, else the Balanced DEFAULT). */
  async getEffectivePolicy(workspaceId: string, ucUid: string | null): Promise<EffectivePolicy> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const row = await tx.provisioningPolicy.findUnique({ where: { workspaceId } });
      if (!row) {
        return {
          ...DEFAULT_PROVISIONING_POLICY,
          maxMailboxesPerWorkspace: null,
          maxAgentsPerWorkspace: null,
          isDefault: true,
        };
      }
      return {
        humanMailboxCreateMode: row.humanMailboxCreateMode,
        humanMailboxEditMode: row.humanMailboxEditMode,
        agentMailboxCreateMode: row.agentMailboxCreateMode,
        agentMailboxEditMode: row.agentMailboxEditMode,
        agentCreateMode: row.agentCreateMode,
        agentEditMode: row.agentEditMode,
        approverMinRole: row.approverMinRole,
        allowSelfServiceOwnMailbox: row.allowSelfServiceOwnMailbox,
        maxMailboxesPerWorkspace: row.maxMailboxesPerWorkspace,
        maxAgentsPerWorkspace: row.maxAgentsPerWorkspace,
        isDefault: false,
      };
    });
  }

  async getView(workspaceId: string, ucUid: string | null): Promise<ProvisioningPolicyView> {
    return this.toView(await this.getEffectivePolicy(workspaceId, ucUid));
  }

  /** Upsert the workspace policy (the controller gates this at ADMIN+). */
  async setPolicy(
    workspaceId: string,
    ucUid: string | null,
    patch: UpdatePolicyInput,
  ): Promise<ProvisioningPolicyView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const fields: Record<string, unknown> = {};
      for (const k of PATCH_KEYS) {
        if (patch[k] !== undefined) fields[k] = patch[k];
      }
      const row = await tx.provisioningPolicy.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          ...DEFAULT_PROVISIONING_POLICY,
          ...fields,
          updatedByUcUid: ucUid,
        } as Prisma.ProvisioningPolicyUncheckedCreateInput,
        update: { ...fields, updatedByUcUid: ucUid },
      });
      return this.toView({
        humanMailboxCreateMode: row.humanMailboxCreateMode,
        humanMailboxEditMode: row.humanMailboxEditMode,
        agentMailboxCreateMode: row.agentMailboxCreateMode,
        agentMailboxEditMode: row.agentMailboxEditMode,
        agentCreateMode: row.agentCreateMode,
        agentEditMode: row.agentEditMode,
        approverMinRole: row.approverMinRole,
        allowSelfServiceOwnMailbox: row.allowSelfServiceOwnMailbox,
        maxMailboxesPerWorkspace: row.maxMailboxesPerWorkspace,
        maxAgentsPerWorkspace: row.maxAgentsPerWorkspace,
        isDefault: false,
      });
    });
  }

  /**
   * Gate a provisioning action under the workspace policy + the caller's role.
   * Throws 403 on deny; returns 'allow' | 'requires_approval'.
   */
  async authorize(
    workspaceId: string,
    ucUid: string | null,
    callerRole: WorkspaceRole,
    action: ProvisionAction,
    opts?: { isSelfOwnMailbox?: boolean },
  ): Promise<ProvisionDecision> {
    const policy = await this.getEffectivePolicy(workspaceId, ucUid);
    const decision = decideProvision({
      mode: this.modeFor(policy, action),
      callerRole,
      approverMinRole: policy.approverMinRole,
      isSelfOwnMailbox: opts?.isSelfOwnMailbox,
      allowSelfServiceOwnMailbox: policy.allowSelfServiceOwnMailbox,
    });
    if (decision === 'deny') {
      throw new ForbiddenException(
        `Your role (${callerRole}) cannot perform "${action}" under this workspace's provisioning policy.`,
      );
    }
    return decision;
  }

  /**
   * File a PENDING provisioning request (what a write surface does when authorize
   * returns 'requires_approval'). The payload is the canonical service input, so
   * the approval flow replays it verbatim. Lives here (not on the requests
   * service) so the agent/mailbox controllers can file without importing the
   * requests module — keeping the module graph acyclic.
   */
  async fileRequest(
    workspaceId: string,
    ucUid: string | null,
    input: FileRequestInput,
  ): Promise<FiledRequestView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const req = await tx.mailboxProvisioningRequest.create({
        data: {
          workspaceId,
          kind: input.kind as ProvisionableKind,
          action: input.action,
          state: ProvisioningRequestState.PENDING,
          payload: input.payload as Prisma.InputJsonValue,
          summary: input.summary,
          requestedByUcUid: ucUid,
          requestedByAgentKey: input.requestedByAgentKey ?? null,
        },
      });
      await tx.agentActionEvent.create({
        data: {
          workspaceId,
          kind: AgentActionKind.PROVISION_REQUESTED,
          actorUcUid: ucUid,
          agentKey: input.requestedByAgentKey ?? null,
          detail: input.summary,
        },
      });
      return { id: req.id, state: req.state, summary: req.summary, kind: req.kind, action: req.action };
    });
  }

  private modeFor(policy: EffectivePolicy, action: ProvisionAction): ProvisioningMode {
    switch (action) {
      case 'agent.create':
        return policy.agentCreateMode;
      case 'agent.edit':
        return policy.agentEditMode;
      case 'humanMailbox.create':
        return policy.humanMailboxCreateMode;
      case 'humanMailbox.edit':
        return policy.humanMailboxEditMode;
      case 'agentMailbox.create':
        return policy.agentMailboxCreateMode;
      case 'agentMailbox.edit':
        return policy.agentMailboxEditMode;
    }
  }

  private toView(p: EffectivePolicy): ProvisioningPolicyView {
    return {
      human_mailbox_create_mode: p.humanMailboxCreateMode,
      human_mailbox_edit_mode: p.humanMailboxEditMode,
      agent_mailbox_create_mode: p.agentMailboxCreateMode,
      agent_mailbox_edit_mode: p.agentMailboxEditMode,
      agent_create_mode: p.agentCreateMode,
      agent_edit_mode: p.agentEditMode,
      approver_min_role: p.approverMinRole,
      allow_self_service_own_mailbox: p.allowSelfServiceOwnMailbox,
      max_mailboxes_per_workspace: p.maxMailboxesPerWorkspace,
      max_agents_per_workspace: p.maxAgentsPerWorkspace,
      is_default: p.isDefault,
    };
  }
}
