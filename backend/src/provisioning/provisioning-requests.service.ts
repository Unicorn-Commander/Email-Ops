/**
 * ProvisioningRequestsService — the approval queue (the review side).
 *
 * Lists PENDING/historical requests, and on approve REPLAYS the stored payload
 * through the SAME canonical service the direct path uses (createMailbox /
 * createAgent / …) so an approved request applies identically. Approve/reject are
 * gated at the policy's approverMinRole. The replay runs OUTSIDE this service's
 * own tx (the canonical services open their own withWorkspace), so we never nest
 * interactive transactions.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentActionKind,
  MailboxProvisioningRequest,
  ProvisioningRequestState,
  WorkspaceRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { roleAtLeast } from '../common/workspace/role-rank';
import { MailboxAccountsService } from '../mailbox-accounts/mailbox-accounts.service';
import { AgentsService } from '../agents/agents.service';
import { ProvisioningPolicyService } from './provisioning-policy.service';
import { ProvisioningRequestView } from './provisioning.types';

@Injectable()
export class ProvisioningRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: ProvisioningPolicyService,
    private readonly mailboxes: MailboxAccountsService,
    private readonly agents: AgentsService,
  ) {}

  /** Requests in the workspace (optionally filtered by state), newest-first. */
  async list(
    workspaceId: string,
    ucUid: string | null,
    state?: ProvisioningRequestState,
  ): Promise<ProvisioningRequestView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const rows = await tx.mailboxProvisioningRequest.findMany({
        where: { workspaceId, ...(state ? { state } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return rows.map((r) => this.toView(r));
    });
  }

  /** Approve a PENDING request: replay it through the canonical service, then stamp. */
  async approve(
    workspaceId: string,
    ucUid: string | null,
    role: WorkspaceRole,
    id: string,
  ): Promise<ProvisioningRequestView> {
    await this.assertApprover(workspaceId, ucUid, role);

    // Atomic claim: flip PENDING→APPROVED in ONE conditional write so two
    // concurrent approvers can't both replay (double-apply). Only the winner gets
    // count===1; the loser sees the row is no longer PENDING.
    const claim = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.mailboxProvisioningRequest.updateMany({
        where: { id, workspaceId, state: ProvisioningRequestState.PENDING },
        data: {
          state: ProvisioningRequestState.APPROVED,
          reviewedByUcUid: ucUid,
          reviewedAt: new Date(),
        },
      }),
    );
    if (claim.count === 0) {
      const existing = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
        tx.mailboxProvisioningRequest.findFirst({ where: { id, workspaceId } }),
      );
      if (!existing) throw new NotFoundException('Provisioning request not found in this workspace.');
      throw new ConflictException(`Request is ${existing.state}, not PENDING.`);
    }
    const req = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.mailboxProvisioningRequest.findFirstOrThrow({ where: { id, workspaceId } }),
    );

    // Replay via the canonical service (its OWN tx — not nested under ours).
    let appliedRefId = '';
    let failure: string | null = null;
    try {
      appliedRefId = await this.replay(workspaceId, ucUid, req);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const updated = await tx.mailboxProvisioningRequest.update({
        where: { id: req.id },
        data: failure
          ? {
              state: ProvisioningRequestState.FAILED,
              reviewedByUcUid: ucUid,
              reviewedAt: new Date(),
              failureReason: failure,
            }
          : {
              state: ProvisioningRequestState.APPLIED,
              reviewedByUcUid: ucUid,
              reviewedAt: new Date(),
              appliedRefId,
              appliedAt: new Date(),
            },
      });
      await tx.agentActionEvent.create({
        data: {
          workspaceId,
          kind: failure ? AgentActionKind.PROVISION_FAILED : AgentActionKind.PROVISION_APPLIED,
          actorUcUid: ucUid,
          agentKey: req.requestedByAgentKey,
          detail: failure ? `${req.summary} — FAILED: ${failure}` : req.summary,
        },
      });
      return this.toView(updated);
    });
  }

  /** Reject a PENDING request (no apply). */
  async reject(
    workspaceId: string,
    ucUid: string | null,
    role: WorkspaceRole,
    id: string,
    note?: string,
  ): Promise<ProvisioningRequestView> {
    await this.assertApprover(workspaceId, ucUid, role);
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      // Atomic claim (conditional on PENDING) so a reject can't clobber a request
      // a concurrent approve already moved to APPROVED/APPLIED.
      const claim = await tx.mailboxProvisioningRequest.updateMany({
        where: { id, workspaceId, state: ProvisioningRequestState.PENDING },
        data: {
          state: ProvisioningRequestState.REJECTED,
          reviewedByUcUid: ucUid,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
      });
      if (claim.count === 0) {
        const existing = await tx.mailboxProvisioningRequest.findFirst({ where: { id, workspaceId } });
        if (!existing) throw new NotFoundException('Provisioning request not found in this workspace.');
        throw new ConflictException(`Request is ${existing.state}, not PENDING.`);
      }
      const updated = await tx.mailboxProvisioningRequest.findFirstOrThrow({
        where: { id, workspaceId },
      });
      await tx.agentActionEvent.create({
        data: {
          workspaceId,
          kind: AgentActionKind.PROVISION_REJECTED,
          actorUcUid: ucUid,
          agentKey: updated.requestedByAgentKey,
          detail: updated.summary,
        },
      });
      return this.toView(updated);
    });
  }

  /** Caller must meet the policy's approverMinRole. */
  private async assertApprover(
    workspaceId: string,
    ucUid: string | null,
    role: WorkspaceRole,
  ): Promise<void> {
    const policy = await this.policy.getEffectivePolicy(workspaceId, ucUid);
    if (!roleAtLeast(role, policy.approverMinRole)) {
      throw new ForbiddenException(
        `Approving provisioning requests requires ${policy.approverMinRole} or above.`,
      );
    }
  }

  /** Replay the stored payload through the canonical apply path; returns the new id. */
  private async replay(
    workspaceId: string,
    ucUid: string | null,
    req: MailboxProvisioningRequest,
  ): Promise<string> {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    if (req.kind === 'HUMAN_MAILBOX' || req.kind === 'AGENT_MAILBOX') {
      if (req.action === 'create') {
        const mb = await this.mailboxes.createMailbox(workspaceId, ucUid, payload as never);
        return mb.id;
      }
      if (req.action === 'update') {
        const mb = await this.mailboxes.updateMailbox(
          workspaceId,
          ucUid,
          payload.id as string,
          payload.patch as never,
        );
        return mb?.id ?? '';
      }
    }
    if (req.kind === 'AGENT') {
      if (req.action === 'create') {
        const a = await this.agents.createAgent(workspaceId, ucUid, payload as never);
        return a.id;
      }
      if (req.action === 'update') {
        const a = await this.agents.updateAgent(
          workspaceId,
          ucUid,
          payload.id as string,
          payload.patch as never,
        );
        return a?.id ?? '';
      }
    }
    throw new BadRequestException(`Unsupported provisioning request: ${req.kind}/${req.action}`);
  }

  private toView(r: MailboxProvisioningRequest): ProvisioningRequestView {
    return {
      id: r.id,
      kind: r.kind,
      action: r.action,
      state: r.state,
      summary: r.summary,
      target_id: r.targetId ?? null,
      requested_by_uc_uid: r.requestedByUcUid ?? null,
      requested_by_agent_key: r.requestedByAgentKey ?? null,
      reviewed_by_uc_uid: r.reviewedByUcUid ?? null,
      reviewed_at: r.reviewedAt?.toISOString() ?? null,
      review_note: r.reviewNote ?? null,
      applied_ref_id: r.appliedRefId ?? null,
      applied_at: r.appliedAt?.toISOString() ?? null,
      failure_reason: r.failureReason ?? null,
      created_at: r.createdAt?.toISOString() ?? null,
    };
  }
}
