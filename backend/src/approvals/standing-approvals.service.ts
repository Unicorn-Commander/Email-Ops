import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmailMessage, Prisma, StandingApproval, User } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { assertMailboxVisible, resolveMailboxScope } from '../common/mailbox/mailbox-scope';
import { ucUidOf } from '../common/workspace/workspace.util';
import { businessDayWindow } from '../common/business-time';
import { StableNotifierService } from '../notify/stable-notifier.service';
import { assertHumanApproval } from './human-approval';
import { ApprovalLinksService, standingTarget } from './approval-links.service';
import {
  assertStandingExpiry,
  recipientRules,
  standingBinding,
  standingRefusalReason,
  standingTemplate,
  standingTemplateSha256,
} from './standing-approval';

export interface StandingRequest {
  campaign_key: string;
  mailbox_id: string;
  body_template: string;
  subject: string;
  placeholder_rules?: Record<string, string>;
  optional_lines?: number[];
  cap_per_day: number;
  expires_at: string;
  recipient_rules?: unknown;
}

@Injectable()
export class StandingApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: ApprovalLinksService,
    private readonly notifier: StableNotifierService,
  ) {}

  async request(workspaceId: string, user: User, input: StandingRequest) {
    assertHumanApproval(user);
    const uid = ucUidOf(user);
    const now = new Date();
    const expiresAt = new Date(input.expires_at);
    assertStandingExpiry(expiresAt, now);
    if (
      typeof input.campaign_key !== 'string' ||
      !input.campaign_key.trim() ||
      input.campaign_key.length > 200 ||
      !Number.isInteger(input.cap_per_day) ||
      input.cap_per_day < 1 ||
      input.cap_per_day > 100000
    ) {
      throw new BadRequestException(
        'A campaign name and daily cap between 1 and 100000 are required.',
      );
    }
    const definition = standingTemplate({
      bodyTemplate: input.body_template,
      subjects: [input.subject],
      placeholderRules: input.placeholder_rules,
      optionalLines: input.optional_lines,
    });
    const rules = recipientRules(input.recipient_rules);
    const result = await this.prisma.withWorkspace(workspaceId, uid, async (tx) => {
      const mailbox = await tx.mailboxAccount.findFirst({
        where: { id: input.mailbox_id, workspaceId },
      });
      if (!mailbox) throw new NotFoundException('Mailbox not found.');
      await assertMailboxVisible(tx, workspaceId, uid, mailbox);
      const row = await tx.standingApproval.create({
        data: {
          id: randomUUID(),
          workspaceId,
          campaignKey: input.campaign_key.trim(),
          mailboxId: mailbox.id,
          fromAddress: mailbox.emailAddress.trim().toLowerCase(),
          templateSha256: standingTemplateSha256(definition),
          bodyTemplate: definition.bodyTemplate,
          subjects: definition.subjects,
          placeholderRules: definition.placeholderRules,
          optionalLines: definition.optionalLines,
          recipientRules: rules as unknown as Prisma.InputJsonValue,
          capPerDay: input.cap_per_day,
          expiresAt,
          createdBy: uid,
          createdAt: now,
        },
      });
      return this.view(tx, row);
    });
    void this.notifier
      .notifyApprovalPending({
        id: result.id,
        workspaceId,
        kind: 'STANDING APPROVAL',
        draftedBy: uid,
        summary: `${result.campaignKey}: ${result.capPerDay} sends/day until ${result.expiresAt.toISOString()}`,
        approvalUrl: result.approval_url,
      })
      .catch(() => undefined);
    return result;
  }

  async list(workspaceId: string, user: User) {
    assertHumanApproval(user);
    return this.prisma.withWorkspace(workspaceId, ucUidOf(user), async (tx) => {
      const scope = await resolveMailboxScope(tx, workspaceId, ucUidOf(user));
      const rows = await tx.standingApproval.findMany({
        where: {
          workspaceId,
          ...(scope.governed ? { mailboxId: { in: scope.ids } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return Promise.all(rows.map((row) => this.view(tx, row)));
    });
  }

  async view(tx: WorkspaceTxClient, row: StandingApproval) {
    const window = businessDayWindow(new Date());
    const usedToday = await tx.standingApprovalUse.count({
      where: {
        workspaceId: row.workspaceId,
        approval: { is: { workspaceId: row.workspaceId, campaignKey: row.campaignKey } },
        reservedAt: { gte: window.start, lt: window.end },
      },
    });
    return {
      ...row,
      ...standingBinding(row),
      usedToday,
      approval_url:
        !row.approvedAt && !row.revokedAt && row.expiresAt > new Date()
          ? await this.links.issue(tx, standingTarget(row))
          : null,
    };
  }

  /** All definition changes/renewals are new immutable requests, never PATCHes. */
  async approve(workspaceId: string, user: User, id: string, definitionSha256: string) {
    assertHumanApproval(user);
    return this.prisma.withWorkspace(workspaceId, ucUidOf(user), async (tx) => {
      const row = await this.loadVisible(tx, workspaceId, user, id);
      return this.approveInTx(tx, workspaceId, user, row, definitionSha256);
    });
  }

  async approveInTx(
    tx: WorkspaceTxClient,
    workspaceId: string,
    user: User,
    row: StandingApproval,
    definitionSha256: string,
  ) {
    assertHumanApproval(user);
    if (standingBinding(row).definitionSha256 !== definitionSha256)
      throw new ConflictException('The campaign definition changed.');
    assertStandingExpiry(row.expiresAt);
    // A campaign has one active revision. The advisory lock serializes approval
    // of different pending revisions, including the empty/first-grant case.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ':standing:' + row.campaignKey}, 0))`;
    const previous = await tx.standingApproval.findMany({
      where: {
        workspaceId,
        campaignKey: row.campaignKey,
        id: { not: row.id },
        approvedAt: { not: null },
        revokedAt: null,
      },
    });
    for (const prior of previous) {
      // Replacing a campaign must not revoke another member's private mailbox
      // approval through a coincidentally identical campaign name.
      await this.loadVisible(tx, workspaceId, user, prior.id);
    }
    await tx.standingApproval.updateMany({
      where: {
        workspaceId,
        campaignKey: row.campaignKey,
        id: { not: row.id },
        approvedAt: { not: null },
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revokedBy: ucUidOf(user) },
    });
    const result = await tx.standingApproval.updateMany({
      where: {
        id: row.id,
        workspaceId,
        approvedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { approvedAt: new Date(), approvedBy: ucUidOf(user) },
    });
    if (result.count !== 1)
      throw new ConflictException('This campaign request is no longer pending.');
    return { id: row.id, approved: true };
  }

  async revoke(workspaceId: string, user: User, id: string) {
    assertHumanApproval(user);
    return this.prisma.withWorkspace(workspaceId, ucUidOf(user), async (tx) => {
      await this.loadVisible(tx, workspaceId, user, id);
      // UPDATE acquires the same row lock as send reservations. Revocation
      // prevents every subsequent reservation, including in other processes.
      await tx.standingApproval.updateMany({
        where: { id, workspaceId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: ucUidOf(user) },
      });
      return { id, revoked: true };
    });
  }

  private async loadVisible(tx: WorkspaceTxClient, workspaceId: string, user: User, id: string) {
    const row = await tx.standingApproval.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException('Campaign approval not found.');
    const mailbox = await tx.mailboxAccount.findFirst({
      where: { id: row.mailboxId, workspaceId },
    });
    if (!mailbox) throw new NotFoundException('Mailbox not found.');
    await assertMailboxVisible(tx, workspaceId, ucUidOf(user), mailbox);
    return row;
  }

  /** Called only inside the existing send authorization transaction. */
  async reserve(
    tx: WorkspaceTxClient,
    workspaceId: string,
    message: EmailMessage,
  ): Promise<string | null> {
    if (!message.mailboxAccountId) return null;
    const candidates = await tx.standingApproval.findMany({
      where: {
        workspaceId,
        mailboxId: message.mailboxAccountId,
        approvedAt: { not: null },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { id: 'asc' },
    });
    for (const candidate of candidates) {
      // Lock before counting; a second sender waits and sees the first committed
      // reservation. The fresh read also observes concurrent revocation.
      await tx.$queryRaw`SELECT "id" FROM "standing_approvals" WHERE "workspaceId" = ${workspaceId} AND "id" = ${candidate.id} FOR UPDATE`;
      const row = await tx.standingApproval.findFirst({ where: { id: candidate.id, workspaceId } });
      if (!row) continue;
      const now = new Date();
      const window = businessDayWindow(now);
      const used = await tx.standingApprovalUse.count({
        where: {
          workspaceId,
          approval: { is: { workspaceId, campaignKey: row.campaignKey } },
          reservedAt: { gte: window.start, lt: window.end },
        },
      });
      if (standingRefusalReason(row, message, used, now)) continue;
      const reserved = await tx.standingApprovalUse.createMany({
        data: {
          workspaceId,
          approvalId: row.id,
          messageId: message.id,
          reservedAt: now,
        },
        skipDuplicates: true,
      });
      if (reserved.count !== 1)
        throw new ConflictException(
          'This message already has a standing-approval send reservation.',
        );
      await tx.emailMessage.update({
        where: { id: message.id, workspaceId },
        data: { standingApprovalId: row.id },
      });
      return row.id;
    }
    return null;
  }
}
