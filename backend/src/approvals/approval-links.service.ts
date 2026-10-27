import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AgentSendKit, ApprovalLink, StandingApproval } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { assertMailboxVisible } from '../common/mailbox/mailbox-scope';
import { ApprovalTokensService } from './approval-tokens.service';
import { DAY_MS, sha256, standingBinding } from './standing-approval';

export type ApprovalKind = 'send-kit' | 'standing';
export interface ApprovalTarget {
  workspaceId: string;
  kind: ApprovalKind;
  targetId: string;
  definitionSha256: string;
  recipientSha256: string;
  expiresAt: Date;
}

export function kitTarget(kit: AgentSendKit): ApprovalTarget {
  return {
    workspaceId: kit.workspaceId,
    kind: 'send-kit',
    targetId: kit.kitId,
    expiresAt: kit.expiresAt,
    // Include expiry: legacy kit hashes do not bind it. Bind the complete stored
    // definition as well, so stale links cannot approve replaced proposals.
    definitionSha256: sha256(
      JSON.stringify({
        templateSha256: kit.templateSha256,
        title: kit.title,
        bodyTemplate: kit.bodyTemplate,
        placeholderRules: kit.placeholderRules,
        optionalLines: kit.optionalLines,
        subjects: kit.subjects,
        recipients: kit.recipients,
        fromAddress: kit.fromAddress,
        capPerDay: kit.capPerDay,
        expiresAt: kit.expiresAt.toISOString(),
        proposedAt: kit.proposedAt?.toISOString(),
      }),
    ),
    recipientSha256: sha256(JSON.stringify([...kit.recipientHashes].sort())),
  };
}

export function standingTarget(row: StandingApproval): ApprovalTarget {
  return {
    workspaceId: row.workspaceId,
    kind: 'standing',
    targetId: row.id,
    expiresAt: row.expiresAt,
    ...standingBinding(row),
  };
}

@Injectable()
export class ApprovalLinksService {
  constructor(private readonly tokens: ApprovalTokensService) {}

  private claims(row: ApprovalLink) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      kind: row.kind,
      targetId: row.targetId,
      definitionSha256: row.definitionSha256,
      recipientSha256: row.recipientSha256,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async issue(tx: WorkspaceTxClient, target: ApprovalTarget): Promise<string> {
    const now = new Date();
    let row = await tx.approvalLink.findFirst({
      where: {
        workspaceId: target.workspaceId,
        kind: target.kind,
        targetId: target.targetId,
        definitionSha256: target.definitionSha256,
        recipientSha256: target.recipientSha256,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row)
      row = await tx.approvalLink.create({
        data: {
          ...target,
          id: randomUUID(),
          createdAt: now,
          expiresAt: new Date(Math.min(now.getTime() + DAY_MS, target.expiresAt.getTime())),
        },
      });
    return this.tokens.linkUrl(
      this.tokens.sign('link', this.claims(row)),
      row.workspaceId,
      row.kind,
      row.targetId,
    );
  }

  /** Reads never consume a link. Approval consumes it in the SAME transaction as the grant. */
  async review(
    tx: WorkspaceTxClient,
    workspaceId: string,
    uid: string,
    kind: ApprovalKind,
    targetId: string,
    token: string,
    consume: boolean,
  ) {
    const claims = this.tokens.verify<ReturnType<ApprovalLinksService['claims']>>('link', token);
    if (
      claims.workspaceId !== workspaceId ||
      claims.kind !== kind ||
      claims.targetId !== targetId
    ) {
      throw new NotFoundException('This link belongs to a different approval.');
    }
    const link = await tx.approvalLink.findFirst({
      where: { id: claims.id, workspaceId, kind, targetId },
    });
    const now = new Date();
    if (
      !link ||
      JSON.stringify(this.claims(link)) !== JSON.stringify(claims) ||
      link.expiresAt <= now ||
      link.consumedAt
    ) {
      throw new ConflictException('This approval link has expired or has already been used.');
    }

    // Lock the target before comparing its binding. Proposal edits and direct
    // approvals then serialize with link consumption; no check/use race.
    if (kind === 'send-kit') {
      await tx.$queryRaw`SELECT "kitId" FROM "agent_send_kits" WHERE "workspaceId" = ${workspaceId} AND "kitId" = ${targetId} FOR UPDATE`;
    } else if (kind === 'standing') {
      const pending = await tx.standingApproval.findFirst({ where: { id: targetId, workspaceId } });
      if (!pending) throw new NotFoundException('Campaign approval not found.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ':standing:' + pending.campaignKey}, 0))`;
      await tx.$queryRaw`SELECT "id" FROM "standing_approvals" WHERE "workspaceId" = ${workspaceId} AND "id" = ${targetId} FOR UPDATE`;
    } else throw new NotFoundException('Unknown approval kind.');
    const kit =
      kind === 'send-kit'
        ? await tx.agentSendKit.findFirst({ where: { kitId: targetId, workspaceId } })
        : null;
    const standing =
      kind === 'standing'
        ? await tx.standingApproval.findFirst({ where: { id: targetId, workspaceId } })
        : null;
    if (
      (!kit && !standing) ||
      (kit && kit.state !== 'PROPOSED') ||
      (standing && (standing.approvedAt || standing.revokedAt))
    ) {
      throw new ConflictException('This approval is no longer pending.');
    }
    const target = kit ? kitTarget(kit) : standingTarget(standing!);
    if (
      target.definitionSha256 !== link.definitionSha256 ||
      target.recipientSha256 !== link.recipientSha256 ||
      target.expiresAt <= new Date() ||
      link.expiresAt <= new Date()
    ) {
      throw new ConflictException(
        'The proposal changed or expired. Open its latest approval link.',
      );
    }
    const mailbox = await tx.mailboxAccount.findFirst({
      where: {
        workspaceId,
        ...(standing
          ? { id: standing.mailboxId }
          : { emailAddress: { equals: kit!.fromAddress, mode: 'insensitive' as const } }),
      },
    });
    if (!mailbox) throw new NotFoundException('Mailbox not found.');
    await assertMailboxVisible(tx, workspaceId, uid, mailbox);
    if (consume) {
      const consumedAt = new Date();
      if (target.expiresAt <= consumedAt) throw new ConflictException('This proposal has expired.');
      const changed = await tx.approvalLink.updateMany({
        where: {
          id: link.id,
          workspaceId,
          consumedAt: null,
          expiresAt: { gt: consumedAt },
        },
        data: { consumedAt },
      });
      if (changed.count !== 1)
        throw new ConflictException('This approval link has already been used.');
    }
    return { kit, standing };
  }
}
