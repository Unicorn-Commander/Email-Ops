/**
 * MailboxAccountsService — the net-new SoR CRUD over MailboxAccount.
 *
 * The canonical write path for human / agent / shared mailboxes (the approval
 * queue replays an approved request through these same methods). Workspace-scoped
 * via withWorkspace; governance actions audited. A created mailbox is REGISTERED
 * (the SoR row); a real engine account is minted later (provisionState →
 * PROVISIONED) when the engine is live — honest while the engine is dormant.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  AgentActionKind,
  MailboxAccount,
  MailboxOwnerKind,
  MailboxProvisionState,
  MembershipStatus,
  Prisma,
  WorkspaceRole,
} from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { roleAtLeast } from '../common/workspace/role-rank';
import {
  assertMailboxVisible,
  MailboxOutOfScopeException,
  resolveMailboxScope,
} from '../common/mailbox/mailbox-scope';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { DeviceConfigService, DeviceConnectionSettings, ManualClientSettings } from './device-config.service';
import { CreateMailboxInput, MailboxView, UpdateMailboxInput } from './mailbox-accounts.types';

@Injectable()
export class MailboxAccountsService {
  private readonly logger = new Logger(MailboxAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: MailEngineAdminPort,
    private readonly deviceConfig: DeviceConfigService,
  ) {}

  /** All mailboxes in the workspace (default first, then alphabetical). */
  async listMailboxes(workspaceId: string, ucUid: string | null): Promise<MailboxView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const scope = await resolveMailboxScope(tx, workspaceId, ucUid);
      const mailboxes = await tx.mailboxAccount.findMany({
        where: { workspaceId, ...(scope.governed ? { id: { in: scope.ids } } : {}) },
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

  /** Count only mailboxes hosted by the James/Stalwart lane for billing gates. */
  async countHostedMailboxes(workspaceId: string, ucUid: string | null): Promise<number> {
    return this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.mailboxAccount.count({
        where: { workspaceId, provider: { in: ['stalwart', 'james'] } },
      }),
    );
  }

  async getMailbox(workspaceId: string, ucUid: string | null, id: string): Promise<MailboxView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const scope = await resolveMailboxScope(tx, workspaceId, ucUid);
      const mb = await tx.mailboxAccount.findFirst({ where: { id, workspaceId } });
      if (scope.governed && mb && !scope.ids.includes(id)) {
        if (scope.patScoped) throw new MailboxOutOfScopeException();
        return null;
      }
      if (scope.governed && !mb) return null;
      return mb ? this.toViewOne(tx, mb) : null;
    });
  }

  async getOwnConnectionSettings(
    workspaceId: string,
    ucUid: string | null,
    id: string,
  ): Promise<(DeviceConnectionSettings & { manual: ManualClientSettings[] }) | null> {
    const settings = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mb = await tx.mailboxAccount.findFirst({ where: { id, workspaceId } });
      if (!mb) return null;
      await assertMailboxVisible(tx, workspaceId, ucUid, mb);
      this.assertOwnHumanMailbox(mb, ucUid);
      return this.deviceConfig.buildConnectionSettings(mb);
    });
    return settings ? { ...settings, manual: this.deviceConfig.buildManualSettings(settings) } : null;
  }

  async buildOwnAppleMobileconfig(
    workspaceId: string,
    ucUid: string | null,
    id: string,
  ): Promise<{ email: string; filename: string; xml: string } | null> {
    const settings = await this.getOwnConnectionSettings(workspaceId, ucUid, id);
    if (!settings) return null;
    const localpart = settings.email.split('@')[0]?.replace(/[^a-zA-Z0-9.-]/g, '-') || 'mailbox';
    return {
      email: settings.email,
      filename: `${localpart}-fabrikam-email.mobileconfig`,
      xml: this.deviceConfig.buildAppleMobileconfig(settings),
    };
  }

  async resetOwnAppPassword(
    workspaceId: string,
    ucUid: string | null,
    id: string,
  ): Promise<{ password: string } | null> {
    const password = this.generateAppPassword();
    const email = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mb = await tx.mailboxAccount.findFirst({ where: { id, workspaceId } });
      if (!mb) return null;
      await assertMailboxVisible(tx, workspaceId, ucUid, mb);
      this.assertOwnHumanMailbox(mb, ucUid);
      return mb.emailAddress;
    });
    if (!email) return null;
    if (!this.admin.isConfigured()) {
      throw new ServiceUnavailableException('James WebAdmin is not configured.');
    }
    const result = await this.admin.setPassword(email, password);
    if (!result.provisioned) {
      throw new ServiceUnavailableException('Could not reset the mailbox password.');
    }
    await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.recordAction(tx, workspaceId, AgentActionKind.MAILBOX_UPDATED, ucUid, `${email} app-password reset`);
    });
    this.logger.log(`Mail app-password reset for ${email} by ${ucUid ?? 'unknown'}`);
    return { password };
  }

  /**
   * Create a mailbox. The SoR row is written first (REGISTERED), then — outside
   * the DB transaction — the real engine account is minted via the admin engine
   * and the row flips to PROVISIONED. Degrade-clean: with no engine wired (or for
   * external accounts) the row stays REGISTERED and this behaves exactly as
   * before. 409 on a duplicate address.
   */
  async createMailbox(
    workspaceId: string,
    ucUid: string | null,
    input: CreateMailboxInput,
  ): Promise<MailboxView> {
    const created = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const ownerKind = input.ownerKind ?? MailboxOwnerKind.SHARED;
      const existingDefault = await tx.mailboxAccount.findFirst({
        where: { workspaceId, isDefault: true },
        select: { id: true },
      });
      // A workspace gets one fallback identity as soon as its first mailbox is
      // registered. An explicit true also atomically hands the flag to the new
      // row; an explicit false preserves the current holder when one exists.
      const makeDefault = input.isDefault === true || !existingDefault;
      try {
        if (makeDefault) {
          await tx.mailboxAccount.updateMany({
            where: { workspaceId, isDefault: true },
            data: { isDefault: false },
          });
        }
        const row = await tx.mailboxAccount.create({
          data: {
            workspaceId,
            emailAddress: input.emailAddress,
            displayName: input.displayName ?? null,
            ownerKind,
            ownerKey: input.ownerKey ?? null,
            kind: ownerKind.toLowerCase(),
            postmarkLane: input.postmarkLane ?? false,
            isDefault: makeDefault,
            // provisionState defaults REGISTERED; active defaults true.
          },
        });
        await this.recordAction(tx, workspaceId, AgentActionKind.MAILBOX_CREATED, ucUid, row.emailAddress);
        return row;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `A mailbox "${input.emailAddress}" already exists in this workspace.`,
          );
        }
        throw err;
      }
    });

    return this.mintOnEngine(workspaceId, ucUid, created);
  }

  /**
   * Mint (or confirm) the real engine account for a freshly REGISTERED sovereign
   * mailbox and flip provisionState → PROVISIONED on success. A no-op (returns
   * the row unchanged, still REGISTERED) when the admin engine is dormant or the
   * mailbox is external (gmail / microsoft authenticate through their provider,
   * not the sovereign engine). NEVER throws — a provisioning failure leaves the
   * row REGISTERED and is logged, so the SoR write is never lost.
   *
   * The WebAdmin call runs OUTSIDE the SoR transaction (it is network I/O, not DB
   * work); the PROVISIONED flip is a tiny follow-up write.
   *
   * NOTE: ensureAccount mints the engine login with a generated password; the
   * intended auth path for these mailboxes is OIDC (James validates the Keycloak
   * token), so the password is a break-glass we can reset. Surfacing/rotating it
   * (or app-passwords for agents) is a follow-up, tracked separately.
   */
  private async mintOnEngine(
    workspaceId: string,
    ucUid: string | null,
    created: MailboxAccount,
  ): Promise<MailboxView> {
    const isExternal =
      !!created.provider && created.provider !== 'stalwart' && created.provider !== 'james';
    if (!this.admin.isConfigured() || isExternal) {
      return this.prisma.withWorkspace(workspaceId, ucUid, (tx) => this.toViewOne(tx, created));
    }

    const res = await this.admin.ensureAccount(created.emailAddress);
    if (!res.provisioned) {
      this.logger.warn(
        `Mailbox ${created.emailAddress} REGISTERED but engine provisioning failed: ${res.reason}`,
      );
      return this.prisma.withWorkspace(workspaceId, ucUid, (tx) => this.toViewOne(tx, created));
    }

    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const updated = await tx.mailboxAccount.update({
        where: { id: created.id },
        data: { provisionState: MailboxProvisionState.PROVISIONED },
      });
      await this.recordAction(
        tx,
        workspaceId,
        AgentActionKind.MAILBOX_UPDATED,
        ucUid,
        `${updated.emailAddress} (engine-provisioned)`,
      );
      return this.toViewOne(tx, updated);
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
    // Stamp the CANONICAL owner key (the uchub sub / keycloakId). ucUid can arrive
    // as the keycloakId OR the local User.id depending on the auth path; resolve the
    // owning user by EITHER and persist the stable keycloakId, so the provider/broker
    // (which resolve a mailbox's owner by keycloakId) can always find them.
    const owner = ucUid
      ? await this.prisma.user.findFirst({ where: { OR: [{ keycloakId: ucUid }, { id: ucUid }] } })
      : null;
    const ownerKey = owner?.keycloakId ?? owner?.id ?? ucUid;
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const existingDefault = await tx.mailboxAccount.findFirst({
        where: { workspaceId, isDefault: true },
        select: { id: true },
      });
      const makeDefault = !existingDefault;
      if (makeDefault) {
        await tx.mailboxAccount.updateMany({
          where: { workspaceId, isDefault: true },
          data: { isDefault: false },
        });
      }
      const mb = await tx.mailboxAccount.upsert({
        where: { workspaceId_emailAddress: { workspaceId, emailAddress: input.emailAddress } },
        create: {
          workspaceId,
          emailAddress: input.emailAddress,
          displayName: input.displayName ?? null,
          provider: input.provider,
          ownerKind: MailboxOwnerKind.HUMAN,
          ownerKey,
          kind: input.provider,
          postmarkLane: false,
          isDefault: makeDefault,
        },
        update: {
          provider: input.provider,
          ownerKind: MailboxOwnerKind.HUMAN,
          ownerKey,
          kind: input.provider,
          active: true,
          ...(makeDefault ? { isDefault: true } : {}),
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
      const scope = await resolveMailboxScope(tx, workspaceId, ucUid);
      const existing = await tx.mailboxAccount.findFirst({ where: { id, workspaceId } });
      if (!existing) return null;
      if (scope.governed && !scope.ids.includes(existing.id)) {
        if (scope.patScoped) throw new MailboxOutOfScopeException();
        return null;
      }

      // Changing ownership is an administrative action even when the caller is
      // otherwise allowed to edit the mailbox through a policy path. Keep the
      // check here as well as in the REST controller so approval replay and any
      // future caller cannot turn owner_key into a member-level write.
      if (patch.ownerKey !== undefined) {
        const keys = new Set<string>(ucUid ? [ucUid] : []);
        if (ucUid) {
          const actor = await tx.user.findFirst({
            where: { OR: [{ keycloakId: ucUid }, { id: ucUid }] },
            select: { id: true, keycloakId: true },
          });
          if (actor?.id) keys.add(actor.id);
          if (actor?.keycloakId) keys.add(actor.keycloakId);
        }
        let membership = ucUid
          ? await tx.membership.findUnique({
              where: { userKey_workspaceId: { userKey: ucUid, workspaceId } },
              select: { role: true, status: true },
            })
          : null;
        if (!membership && keys.size > 1) {
          membership = await tx.membership.findFirst({
            where: { workspaceId, userKey: { in: [...keys] } },
            select: { role: true, status: true },
          });
        }
        if (
          membership &&
          (membership.status !== MembershipStatus.ACTIVE || !roleAtLeast(membership.role, WorkspaceRole.ADMIN))
        ) {
          throw new ForbiddenException('Only a workspace admin or owner may change mailbox ownership.');
        }
      }

      const data: Prisma.MailboxAccountUncheckedUpdateInput = {};
      if (patch.displayName !== undefined) data.displayName = patch.displayName;
      if (patch.ownerKind !== undefined) {
        data.ownerKind = patch.ownerKind;
        data.kind = patch.ownerKind.toLowerCase();
      }
      if (patch.ownerKey !== undefined) data.ownerKey = patch.ownerKey;
      if (patch.postmarkLane !== undefined) data.postmarkLane = patch.postmarkLane;
      if (patch.active !== undefined) data.active = patch.active;
      if (patch.isDefault !== undefined) data.isDefault = patch.isDefault;
      if (Object.keys(data).length === 0) return this.toViewOne(tx, existing);

      if (
        patch.isDefault === true &&
        (patch.active === false || (!existing.active && patch.active !== true))
      ) {
        throw new BadRequestException('An inactive mailbox cannot be the workspace default.');
      }

      // Removing or parking the current default must promote another active
      // mailbox in the same transaction, so sends never fall into a default-less
      // workspace. A caller can still set a different mailbox directly.
      const needsReplacement =
        existing.isDefault &&
        (patch.isDefault === false || (patch.active === false && patch.isDefault !== true));
      const replacement = needsReplacement
        ? await tx.mailboxAccount.findFirst({
            where: { workspaceId, id: { not: existing.id }, active: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            select: { id: true },
          })
        : null;
      if (needsReplacement && !replacement) {
        throw new ConflictException(
          'The workspace must keep one active default mailbox; set another mailbox first.',
        );
      }
      if (replacement) data.isDefault = false;

      if (patch.isDefault === true || replacement) {
        await tx.mailboxAccount.updateMany({
          where: { workspaceId, isDefault: true },
          data: { isDefault: false },
        });
        if (replacement) {
          await tx.mailboxAccount.update({
            where: { id: replacement.id },
            data: { isDefault: true },
          });
        }
      }

      const updated = await tx.mailboxAccount.update({ where: { id: existing.id }, data });
      await this.recordAction(tx, workspaceId, AgentActionKind.MAILBOX_UPDATED, ucUid, updated.emailAddress);
      return this.toViewOne(tx, updated);
    });
  }

  /**
   * Delete only an unreferenced registry row. Engine account teardown remains
   * an explicit control-plane action; deleting the SoR row must never orphan
   * messages, agent bindings, or approved send identities.
   */
  async deleteMailbox(
    workspaceId: string,
    ucUid: string | null,
    id: string,
  ): Promise<{ id: string; deleted: true } | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const scope = await resolveMailboxScope(tx, workspaceId, ucUid);
      const mailbox = await tx.mailboxAccount.findFirst({ where: { id, workspaceId } });
      if (!mailbox || (scope.governed && !scope.ids.includes(mailbox.id))) return null;

      const messages = await tx.emailMessage.findMany({
        where: { workspaceId, mailboxAccountId: mailbox.id },
        select: { threadId: true },
      });
      const blockers: Record<string, number> = {};
      if (messages.length) blockers.messages = messages.length;
      const threadCount = new Set(
        messages.map((message) => message.threadId).filter((threadId): threadId is string => !!threadId),
      ).size;
      if (threadCount) blockers.threads = threadCount;

      const agentCount = await tx.agent.count({
        where: {
          workspaceId,
          OR: [
            { mailboxAccountId: mailbox.id },
            { mailboxes: { some: { mailboxAccountId: mailbox.id } } },
          ],
        },
      });
      if (agentCount) blockers.agents = agentCount;

      const kitCount = await tx.agentSendKit.count({
        where: {
          workspaceId,
          fromAddress: { equals: mailbox.emailAddress, mode: 'insensitive' },
        },
      });
      if (kitCount) blockers.kits = kitCount;

      // This relation is RESTRICT rather than CASCADE in Prisma, so expose it
      // as a blocker before attempting the delete instead of returning a 500.
      const standingApprovalCount = await tx.standingApproval.count({
        where: { workspaceId, mailboxId: mailbox.id },
      });
      if (standingApprovalCount) blockers.standing_approvals = standingApprovalCount;

      if (Object.keys(blockers).length) {
        throw new ConflictException({
          message: 'Mailbox cannot be deleted while it is still referenced.',
          blockers,
        });
      }

      await tx.mailboxAccount.delete({ where: { id: mailbox.id } });
      return { id: mailbox.id, deleted: true as const };
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

  private assertOwnHumanMailbox(mb: MailboxAccount, ucUid: string | null): void {
    if (!ucUid || mb.ownerKind !== MailboxOwnerKind.HUMAN || mb.ownerKey !== ucUid) {
      throw new ForbiddenException('Mailbox is not owned by the current user.');
    }
    const provider = (mb.provider ?? 'stalwart').toLowerCase();
    if (provider !== 'stalwart' && provider !== 'james') {
      throw new BadRequestException('Device setup is only available for hosted mailboxes.');
    }
  }

  private generateAppPassword(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = randomBytes(24);
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
    return `${chars.slice(0, 6).join('')}-${chars.slice(6, 12).join('')}-${chars.slice(12, 18).join('')}-${chars.slice(18, 24).join('')}`;
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
