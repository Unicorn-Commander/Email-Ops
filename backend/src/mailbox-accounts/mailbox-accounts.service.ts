/**
 * MailboxAccountsService — the net-new SoR CRUD over MailboxAccount.
 *
 * The canonical write path for human / agent / shared mailboxes (the approval
 * queue replays an approved request through these same methods). Workspace-scoped
 * via withWorkspace; governance actions audited. A created mailbox is REGISTERED
 * (the SoR row); a real engine account is minted later (provisionState →
 * PROVISIONED) when the engine is live — honest while the engine is dormant.
 */

import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  AgentActionKind,
  MailboxAccount,
  MailboxOwnerKind,
  Prisma,
} from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { CreateMailboxInput, MailboxView, UpdateMailboxInput } from './mailbox-accounts.types';

@Injectable()
export class MailboxAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All mailboxes in the workspace (default first, then alphabetical). */
  async listMailboxes(workspaceId: string, ucUid: string | null): Promise<MailboxView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailboxes = await tx.mailboxAccount.findMany({
        where: { workspaceId },
        orderBy: [{ isDefault: 'desc' }, { emailAddress: 'asc' }],
      });
      return this.toViews(tx, workspaceId, mailboxes);
    });
  }

  /** How many mailboxes the workspace has (for the policy cap). */
  async countMailboxes(workspaceId: string, ucUid: string | null): Promise<number> {
    return this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.mailboxAccount.count({ where: { workspaceId } }),
    );
  }

  async getMailbox(workspaceId: string, ucUid: string | null, id: string): Promise<MailboxView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mb = await tx.mailboxAccount.findFirst({ where: { id, workspaceId } });
      return mb ? this.toViewOne(tx, mb) : null;
    });
  }

  /** Create a mailbox (REGISTERED). 409 on a duplicate address. */
  async createMailbox(
    workspaceId: string,
    ucUid: string | null,
    input: CreateMailboxInput,
  ): Promise<MailboxView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const ownerKind = input.ownerKind ?? MailboxOwnerKind.SHARED;
      try {
        const created = await tx.mailboxAccount.create({
          data: {
            workspaceId,
            emailAddress: input.emailAddress,
            displayName: input.displayName ?? null,
            ownerKind,
            ownerKey: input.ownerKey ?? null,
            kind: ownerKind.toLowerCase(),
            postmarkLane: input.postmarkLane ?? true,
            // provisionState defaults REGISTERED; isDefault false; active true.
          },
        });
        await this.recordAction(tx, workspaceId, AgentActionKind.MAILBOX_CREATED, ucUid, created.emailAddress);
        return this.toViewOne(tx, created);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `A mailbox "${input.emailAddress}" already exists in this workspace.`,
          );
        }
        throw err;
      }
    });
  }

  /**
   * Register a user's linked EXTERNAL account (gmail / microsoft) as a mailbox so
   * it appears in /mail and reads/sends through its provider. Self-service: the
   * caller owns it (ownerKind HUMAN, ownerKey = their uchub sub). Idempotent on
   * (workspace, address) — re-connecting just re-points it. No secret stored: the
   * Keycloak broker holds the token. postmarkLane=false (it sends via its own API).
   */
  async connectExternalMailbox(
    workspaceId: string,
    ucUid: string | null,
    input: { provider: 'gmail' | 'microsoft'; emailAddress: string; displayName?: string | null },
  ): Promise<MailboxView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mb = await tx.mailboxAccount.upsert({
        where: { workspaceId_emailAddress: { workspaceId, emailAddress: input.emailAddress } },
        create: {
          workspaceId,
          emailAddress: input.emailAddress,
          displayName: input.displayName ?? null,
          provider: input.provider,
          ownerKind: MailboxOwnerKind.HUMAN,
          ownerKey: ucUid,
          kind: input.provider,
          postmarkLane: false,
        },
        update: {
          provider: input.provider,
          ownerKind: MailboxOwnerKind.HUMAN,
          ownerKey: ucUid,
          kind: input.provider,
          active: true,
        },
      });
      await this.recordAction(
        tx,
        workspaceId,
        AgentActionKind.MAILBOX_CREATED,
        ucUid,
        `${input.provider}:${mb.emailAddress}`,
      );
      return this.toViewOne(tx, mb);
    });
  }

  /** Patch a mailbox. Null → 404; explicit null clears a nullable field. */
  async updateMailbox(
    workspaceId: string,
    ucUid: string | null,
    id: string,
    patch: UpdateMailboxInput,
  ): Promise<MailboxView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const existing = await tx.mailboxAccount.findFirst({ where: { id, workspaceId } });
      if (!existing) return null;

      const data: Prisma.MailboxAccountUncheckedUpdateInput = {};
      if (patch.displayName !== undefined) data.displayName = patch.displayName;
      if (patch.ownerKind !== undefined) {
        data.ownerKind = patch.ownerKind;
        data.kind = patch.ownerKind.toLowerCase();
      }
      if (patch.ownerKey !== undefined) data.ownerKey = patch.ownerKey;
      if (patch.postmarkLane !== undefined) data.postmarkLane = patch.postmarkLane;
      if (patch.active !== undefined) data.active = patch.active;
      if (Object.keys(data).length === 0) return this.toViewOne(tx, existing);

      const updated = await tx.mailboxAccount.update({ where: { id: existing.id }, data });
      await this.recordAction(tx, workspaceId, AgentActionKind.MAILBOX_UPDATED, ucUid, updated.emailAddress);
      return this.toViewOne(tx, updated);
    });
  }

  // ── view mapping ──────────────────────────────────────────────────────

  private async toViews(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailboxes: MailboxAccount[],
  ): Promise<MailboxView[]> {
    if (mailboxes.length === 0) return [];
    const grouped = await tx.agentMailbox.groupBy({
      by: ['mailboxAccountId'],
      where: { workspaceId, mailboxAccountId: { in: mailboxes.map((m) => m.id) } },
      _count: { _all: true },
    });
    const countById = new Map(grouped.map((g) => [g.mailboxAccountId, g._count._all]));
    return mailboxes.map((m) => this.toView(m, countById.get(m.id) ?? 0));
  }

  private async toViewOne(tx: WorkspaceTxClient, mailbox: MailboxAccount): Promise<MailboxView> {
    const agentCount = await tx.agentMailbox.count({
      where: { workspaceId: mailbox.workspaceId, mailboxAccountId: mailbox.id },
    });
    return this.toView(mailbox, agentCount);
  }

  private toView(m: MailboxAccount, agentCount: number): MailboxView {
    return {
      id: m.id,
      email_address: m.emailAddress,
      display_name: m.displayName,
      owner_kind: m.ownerKind,
      owner_key: m.ownerKey,
      kind: m.kind,
      provider: m.provider,
      provision_state: m.provisionState,
      is_default: m.isDefault,
      postmark_lane: m.postmarkLane,
      active: m.active,
      agent_count: agentCount,
      created_at: m.createdAt?.toISOString() ?? null,
      updated_at: m.updatedAt?.toISOString() ?? null,
    };
  }

  private async recordAction(
    tx: WorkspaceTxClient,
    workspaceId: string,
    kind: AgentActionKind,
    actorUcUid: string | null,
    detail: string | null,
  ): Promise<void> {
    await tx.agentActionEvent.create({ data: { workspaceId, kind, actorUcUid, detail } });
  }

  /** Guard: a mailbox address must be valid-ish (cheap; the engine validates for real). */
  assertValidAddress(emailAddress: string): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
      throw new BadRequestException('email_address must be a valid email address.');
    }
  }
}
