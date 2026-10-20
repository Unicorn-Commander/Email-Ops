import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AgentInboxApprovalTier, AgentInboxKind, MailRule, Prisma } from '@prisma/client';
import { assertMailboxVisible } from '../common/mailbox/mailbox-scope';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartMessageDetail } from '../stalwart/stalwart.types';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { MailboxAccount } from '@prisma/client';
import {
  CompiledRule,
  Condition,
  evaluateRules,
  InboundMessage,
  MatchNode,
  parseActions,
  parseMatch,
  RuleAction,
} from './rule-engine';
import {
  ApplyInboundSummary,
  CreateMailRuleInput,
  InboundRuleMessage,
  MailRuleRow,
  MailRuleView,
  UpdateMailRuleInput,
} from './mail-rules.types';

// Attribution sub for the applicator's fenced hit-counter writes (system path —
// no acting human; same register as the watcher's 'inbound-watcher').
const APPLICATOR_UC_UID = 'mail-rules';
const MAX_RULES_PER_MAILBOX = 100;
// Auto-assigned priorities step by 10 so a UI can insert between rules later.
const PRIORITY_STEP = 10;
// Priorities live in an int4 column; bound accepted values well inside it so
// auto-assign (max + 10) can never overflow.
const PRIORITY_MAX = 1_000_000_000;
// Structural caps for the match tree on WRITE (the engine keeps evaluating
// legacy stored shapes beyond them — see the contract in mail-rules.types.ts).
const MAX_MATCH_GROUPS = 5;
const MAX_MATCH_CONDITIONS_PER_GROUP = 10;
const MAX_NOTIFY_NOTE_LENGTH = 200;
const MAX_FORWARD_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Mail-rules CRUD + the inbound APPLICATOR. CRUD is workspace-member surface:
 * every query runs through withWorkspace AND scopes by BOTH workspaceId and
 * mailboxId (the explicit tenant fence alongside RLS — same doctrine as
 * scheduling). The applicator is a system path invoked per new inbound message
 * by the InboundWatcherService; it NEVER throws into the watcher (degrade-clean).
 */
@Injectable()
export class MailRulesService {
  private readonly logger = new Logger(MailRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
    private readonly mailProvider: MailProviderPort,
  ) {}

  async list(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<MailRuleView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, ucUid, mailboxId);
      const rows = await tx.mailRule.findMany({
        where: { workspaceId, mailboxId },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.map((row) => this.view(row));
    });
  }

  async create(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    input: CreateMailRuleInput,
  ): Promise<MailRuleView> {
    // Pure validation BEFORE the transaction — a bad payload never opens a tx.
    const name = this.normalizeName(input.name);
    const match = this.compileMatch(input.match);
    const actions = this.compileActions(input.actions);
    const explicitPriority =
      input.priority === undefined ? null : this.normalizePriority(input.priority);

    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mbx = await this.assertMailbox(tx, workspaceId, ucUid, mailboxId, {
        requireActive: true,
      });
      // External (Gmail/M365) mailboxes have no folder model, so a MOVE_TO_FOLDER
      // rule would never fire there — reject it at create so the rule isn't a
      // silent no-op. ARCHIVE / TRASH / MARK_READ all map to provider triage verbs.
      if (mbx.provider !== 'stalwart' && actions.some((a) => a.type === 'MOVE_TO_FOLDER')) {
        throw new BadRequestException(
          'Move-to-folder rules are not supported on connected Gmail/Microsoft mailboxes — use Archive, Trash, or Mark-read.',
        );
      }
      await this.validateActionPolicy(tx, workspaceId, mbx, actions);
      const count = await tx.mailRule.count({ where: { workspaceId, mailboxId } });
      if (count >= MAX_RULES_PER_MAILBOX) {
        throw new BadRequestException(
          `This mailbox already has the maximum of ${MAX_RULES_PER_MAILBOX} rules.`,
        );
      }
      let priority = explicitPriority;
      if (priority === null) {
        const agg = await tx.mailRule.aggregate({
          where: { workspaceId, mailboxId },
          _max: { priority: true },
        });
        priority = (agg._max.priority ?? 0) + PRIORITY_STEP;
      }
      const row = await tx.mailRule.create({
        data: {
          workspaceId,
          mailboxId,
          name,
          enabled: input.enabled ?? true,
          priority,
          // Store the PARSED (sanitized) forms, never the raw body.
          match: match as unknown as Prisma.InputJsonValue,
          actions: actions as unknown as Prisma.InputJsonValue,
          createdBy: ucUid || null,
        },
      });
      return this.view(row);
    });
  }

  /** Null when the rule is not in this workspace+mailbox (controller → 404). */
  async update(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    ruleId: string,
    input: UpdateMailRuleInput,
  ): Promise<MailRuleView | null> {
    // Same per-field validation as create, applied only to provided fields.
    // `!= null` (not `!== undefined`): class-validator's @IsOptional also lets
    // an explicit null through, and a null must read as "not provided" — never
    // reach Prisma as a null write on a non-nullable column (500).
    const data: Prisma.MailRuleUpdateInput = {};
    let compiledActions: RuleAction[] | null = null;
    if (input.name != null) data.name = this.normalizeName(input.name);
    if (input.enabled != null) data.enabled = input.enabled;
    if (input.priority != null) data.priority = this.normalizePriority(input.priority);
    if (input.match != null) {
      data.match = this.compileMatch(input.match) as unknown as Prisma.InputJsonValue;
    }
    if (input.actions != null) {
      compiledActions = this.compileActions(input.actions);
      data.actions = compiledActions as unknown as Prisma.InputJsonValue;
    }

    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mbx = await this.assertMailbox(tx, workspaceId, ucUid, mailboxId);
      const existing = await tx.mailRule.findFirst({
        where: { id: ruleId, workspaceId, mailboxId },
      });
      if (!existing) return null;
      await this.validateActionPolicy(
        tx,
        workspaceId,
        mbx,
        compiledActions ?? parseActions(existing.actions),
      );
      if (Object.keys(data).length === 0) return this.view(existing); // empty PATCH = read-back
      const row = await tx.mailRule.update({ where: { id: ruleId }, data });
      return this.view(row);
    });
  }

  /** False when the rule is not in this workspace+mailbox (controller → 404). */
  async remove(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    ruleId: string,
  ): Promise<boolean> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, ucUid, mailboxId);
      const res = await tx.mailRule.deleteMany({ where: { id: ruleId, workspaceId, mailboxId } });
      return res.count === 1;
    });
  }

  /**
   * Apply this mailbox's enabled rules to one newly arrived message. Called by
   * the inbound watcher right after triage; `preloadedRules` (the watcher's
   * once-per-sweep enabled-rule load, grouped by mailbox) skips the per-message
   * query. Actions execute IN ORDER via the same engine primitives the webmail
   * uses — when several folder placements match (e.g. a MOVE then a TRASH), the
   * LAST executed placement wins, exactly like a user clicking both in sequence.
   * Degrade-clean: a dormant engine / failed action logs and continues; this
   * method NEVER throws into the watcher.
   */
  async applyInbound(
    workspaceId: string,
    mailboxId: string,
    mailboxEmail: string,
    msg: InboundRuleMessage,
    preloadedRules?: MailRuleRow[],
    // The full mailbox row: when it is an EXTERNAL (Gmail/M365) account, rule
    // actions execute through the provider instead of James. Omitted (tests /
    // sovereign) → the James path, unchanged.
    mailbox?: MailboxAccount,
  ): Promise<ApplyInboundSummary> {
    const none: ApplyInboundSummary = { matched: 0, applied: 0 };
    try {
      const rows: MailRuleRow[] =
        preloadedRules ??
        (await this.prisma.systemClient.mailRule.findMany({
          where: { workspaceId, mailboxId, enabled: true },
          select: {
            id: true,
            workspaceId: true,
            mailboxId: true,
            name: true,
            enabled: true,
            priority: true,
            match: true,
            actions: true,
          },
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        }));
      // Belt-and-braces fence: never act on a row for another tenant/mailbox,
      // even if a caller hands over a mis-grouped preload.
      const usable = rows.filter(
        (r) => r.enabled && r.workspaceId === workspaceId && r.mailboxId === mailboxId,
      );
      if (usable.length === 0) return none;

      const compiled: CompiledRule[] = usable.map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        priority: row.priority,
        match: parseMatch(row.match),
        actions: parseActions(row.actions),
      }));
      const inbound: InboundMessage = {
        fromAddress: msg.fromAddress ?? '',
        // The REAL To header only. toAddress stays '' so the engine's back-compat
        // fallback can never resurface the old mailbox-address stand-in (which
        // made 'to' conditions constant-valued — always or never matching).
        toAddress: '',
        toAddresses: msg.toAddresses ?? [],
        subject: msg.subject ?? '',
      };
      // One authoritative evaluation produces the action list (STOP honored).
      const sorted = [...compiled].sort((a, b) => a.priority - b.priority);
      const actions = evaluateRules(sorted, inbound);
      // evaluateRules doesn't report WHICH rules fired, so replay its documented
      // walk (priority asc, stop after a STOP-emitting rule) with single-rule
      // calls to collect the matched ids for the hit counters.
      const matchedIds: string[] = [];
      for (const rule of sorted) {
        const ruleActions = evaluateRules([rule], inbound);
        if (ruleActions.length === 0) continue;
        matchedIds.push(rule.id);
        if (ruleActions.some((a) => a.type === 'STOP')) break;
      }
      if (matchedIds.length === 0) return none;

      const actionPlans: { ruleId: string; ruleName: string; actionCount: number }[] = [];
      for (const rule of sorted) {
        const ruleActions = evaluateRules([rule], inbound);
        if (ruleActions.length === 0) continue;
        actionPlans.push({
          ruleId: rule.id,
          ruleName: rule.name ?? rule.id,
          actionCount: ruleActions.length,
        });
        if (ruleActions.some((a) => a.type === 'STOP')) break;
      }

      let applied = 0;
      let actionIndex = 0;
      for (const plan of actionPlans) {
        const ruleActions = actions.slice(actionIndex, actionIndex + plan.actionCount);
        actionIndex += plan.actionCount;
        for (const action of ruleActions) {
          if (action.type === 'STOP') continue; // evaluation terminator - no engine effect
          try {
            const ok = await this.executeAction(
              workspaceId,
              mailboxId,
              mailboxEmail,
              msg,
              plan.ruleId,
              plan.ruleName,
              action,
              mailbox,
            );
            if (ok === null) {
              this.logger.debug(
                `rules: skipping action ${action.type} (unsupported) mailbox=${mailboxId}`,
              );
            } else if (ok) {
              applied += 1;
            } else {
              // Port degrade-clean (dormant engine / unknown thread): not an error.
              this.logger.debug(
                `rules: ${action.type} not applied (engine declined) thread=${msg.threadId}`,
              );
            }
          } catch (err) {
            this.logger.warn(
              `rules: ${action.type} failed thread=${msg.threadId} mailbox=${mailboxId}: ${(err as Error).message}`,
            );
          }
        }
      }

      try {
        // Fenced observability write; failure never voids the applied actions.
        await this.prisma.withWorkspace(workspaceId, APPLICATOR_UC_UID, (tx) =>
          tx.mailRule.updateMany({
            where: { id: { in: matchedIds }, workspaceId, mailboxId },
            data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
          }),
        );
      } catch (err) {
        this.logger.warn(
          `rules: hit-counter bump failed mailbox=${mailboxId}: ${(err as Error).message}`,
        );
      }

      return { matched: matchedIds.length, applied };
    } catch (err) {
      this.logger.warn(
        `rules: apply failed mailbox=${mailboxId} thread=${msg.threadId}: ${(err as Error).message}`,
      );
      return none;
    }
  }

  /** True/false = engine outcome; null = unsupported here (LABEL / blank move target). */
  private async executeAction(
    workspaceId: string,
    mailboxId: string,
    mailboxEmail: string,
    msg: InboundRuleMessage,
    ruleId: string,
    ruleName: string,
    action: RuleAction,
    mailbox?: MailboxAccount,
  ): Promise<boolean | null> {
    if (action.type === 'NOTIFY') {
      return this.createNotice(
        workspaceId,
        mailboxId,
        mailboxEmail,
        msg,
        ruleId,
        ruleName,
        action.value,
      );
    }

    // EXTERNAL (Gmail/M365): actions execute through the provider triage verbs.
    // MOVE_TO_FOLDER has no external equivalent (Gmail/Graph folders aren't
    // modelled here), so it's an honest skip (null) rather than a silent no-op.
    if (mailbox && this.mailProvider.handles(mailbox)) {
      switch (action.type) {
        case 'ARCHIVE':
          return this.mailProvider.archiveThread(mailbox, msg.threadId);
        case 'TRASH':
          return this.mailProvider.trashThread(mailbox, msg.threadId);
        case 'MARK_READ':
          return this.mailProvider.setThreadRead(mailbox, msg.threadId, true);
        case 'MOVE_TO_FOLDER':
        case 'FORWARD_COPY':
        default:
          return null; // MOVE_TO_FOLDER / LABEL unsupported on external — honest skip
      }
    }
    switch (action.type) {
      case 'MOVE_TO_FOLDER': {
        // Same primitive + identifier semantics as the webmail move flow
        // (PUT .../threads/:threadId/move): value is a JMAP folder id from
        // GET .../folders; the engine validates it belongs to this account.
        const folderId = (action.value ?? '').trim();
        if (!folderId) return null;
        return this.stalwart.moveThreadToMailbox(mailboxEmail, msg.threadId, folderId);
      }
      case 'ARCHIVE':
        return this.stalwart.moveThreadToFolder(mailboxEmail, msg.threadId, 'archive');
      case 'TRASH':
        return this.stalwart.moveThreadToFolder(mailboxEmail, msg.threadId, 'trash');
      case 'MARK_READ':
        return this.stalwart.setThreadRead(mailboxEmail, msg.threadId, true);
      case 'FORWARD_COPY':
        return this.forwardCopy(workspaceId, mailboxEmail, msg, ruleId, action.value, mailbox);
      default:
        return null; // LABEL (not supported yet) or unknown — skipped with a debug log
    }
  }

  private async forwardCopy(
    workspaceId: string,
    mailboxEmail: string,
    msg: InboundRuleMessage,
    ruleId: string,
    destinationValue: string | undefined,
    mailbox?: MailboxAccount,
  ): Promise<boolean | null> {
    if (mailbox && mailbox.provider !== 'stalwart') return null;
    const destination = destinationValue?.trim();
    if (!destination) return null;
    if (
      msg.forwardedFrom?.trim() ||
      this.sameAddress(msg.fromAddress, destination) ||
      this.sameAddress(mailboxEmail, destination)
    ) {
      return false;
    }

    const detail = await this.findForwardDetail(mailboxEmail, msg);
    if (!detail) return false;
    if (this.forwardedHeader(detail.headers)) return false;

    const originalFrom = detail.from?.address ?? msg.fromAddress;
    if (!originalFrom || this.sameAddress(originalFrom, destination)) return false;
    const originalSubject = detail.subject ?? msg.subject ?? '';
    const originalDate = detail.sentAt ?? msg.receivedAt ?? '';
    const originalTo = detail.to.length
      ? detail.to.map((participant) => participant.address).join(', ')
      : (msg.toAddresses ?? []).join(', ');
    const originalMessageId =
      detail.messageIdHeader?.trim() || msg.messageIdHeader?.trim() || msg.threadId;
    const attachment = await this.prepareForwardAttachment(mailboxEmail, detail);
    if (attachment.unavailable) return false;

    const bodyLines = [
      `From: ${originalFrom}`,
      `Date: ${originalDate}`,
      `To: ${originalTo}`,
      `Subject: ${originalSubject}`,
      '',
      detail.textBody ?? '',
    ];
    if (attachment.tooLarge) {
      bodyLines.push('', 'The original message was too large to attach.');
    }

    const markerMessageId = msg.messageId?.trim() || msg.threadId;
    if (!markerMessageId || !(await this.claimForward(workspaceId, ruleId, markerMessageId))) {
      return false;
    }

    const htmlBody = detail.htmlBody
      ? [
          '<div>',
          `<p><strong>From:</strong> ${this.escapeHtml(originalFrom)}</p>`,
          `<p><strong>Date:</strong> ${this.escapeHtml(originalDate)}</p>`,
          `<p><strong>To:</strong> ${this.escapeHtml(originalTo)}</p>`,
          `<p><strong>Subject:</strong> ${this.escapeHtml(originalSubject)}</p>`,
          '</div><hr>',
          detail.htmlBody,
          ...(attachment.tooLarge ? ['<p>The original message was too large to attach.</p>'] : []),
        ].join('')
      : null;
    const sent = await this.stalwart.send(
      mailboxEmail,
      {
        fromAddress: mailboxEmail,
        toAddress: destination,
        subject: `Fwd: ${originalSubject}`,
        body: bodyLines.join('\n'),
        bodyHtml: htmlBody,
        replyTo: originalFrom,
        headers: [
          { name: 'X-Email-Ops-Rule', value: ruleId },
          { name: 'X-Email-Ops-Forwarded-From', value: originalMessageId },
        ],
        ...(attachment.blobId
          ? {
              attachments: [
                { blobId: attachment.blobId, name: 'original.eml', type: 'message/rfc822' },
              ],
            }
          : {}),
      },
      false,
    );
    return sent.accepted;
  }

  private async findForwardDetail(
    mailboxEmail: string,
    msg: InboundRuleMessage,
  ): Promise<StalwartMessageDetail | null> {
    const details = await this.stalwart.getThreadDetail(mailboxEmail, msg.threadId);
    if (!details.length) return null;
    if (msg.messageId) {
      const exact = details.find((detail) => detail.id === msg.messageId);
      if (exact) return exact;
    }
    if (msg.messageIdHeader) {
      const header = msg.messageIdHeader.replace(/^<|>$/g, '').toLowerCase();
      const exact = details.find(
        (detail) => detail.messageIdHeader?.replace(/^<|>$/g, '').toLowerCase() === header,
      );
      if (exact) return exact;
    }
    const received = details.filter((detail) => detail.direction === 'received');
    return received[received.length - 1] ?? details[details.length - 1] ?? null;
  }

  private async prepareForwardAttachment(
    mailboxEmail: string,
    detail: StalwartMessageDetail,
  ): Promise<{ blobId: string | null; tooLarge: boolean; unavailable: boolean }> {
    if (detail.rawBlobId) {
      if (typeof detail.size === 'number') {
        return {
          blobId: detail.size <= MAX_FORWARD_ATTACHMENT_BYTES ? detail.rawBlobId : null,
          tooLarge: detail.size > MAX_FORWARD_ATTACHMENT_BYTES,
          unavailable: false,
        };
      }
      const downloaded = await this.stalwart.downloadBlob(mailboxEmail, detail.rawBlobId);
      if (!downloaded) return { blobId: null, tooLarge: false, unavailable: true };
      return {
        blobId: detail.rawBlobId,
        tooLarge: downloaded.data.length > MAX_FORWARD_ATTACHMENT_BYTES,
        unavailable: false,
      };
    }

    const synthetic = Buffer.from(this.renderOriginalEml(detail), 'utf8');
    if (synthetic.length > MAX_FORWARD_ATTACHMENT_BYTES) {
      return { blobId: null, tooLarge: true, unavailable: false };
    }
    const uploaded = await this.stalwart.uploadBlob(
      mailboxEmail,
      synthetic,
      'message/rfc822',
      'original.eml',
    );
    return uploaded
      ? { blobId: uploaded.blobId, tooLarge: false, unavailable: false }
      : { blobId: null, tooLarge: false, unavailable: true };
  }

  private renderOriginalEml(detail: StalwartMessageDetail): string {
    const from = detail.from?.address ?? '';
    const to = detail.to.map((participant) => participant.address).join(', ');
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Date: ${detail.sentAt ?? ''}`,
      `Subject: ${detail.subject ?? ''}`,
      ...(detail.messageIdHeader ? [`Message-ID: ${detail.messageIdHeader}`] : []),
    ];
    return `${headers.join('\r\n')}\r\n\r\n${detail.textBody ?? detail.htmlBody ?? ''}`;
  }

  private claimForward(workspaceId: string, ruleId: string, messageId: string): Promise<boolean> {
    return this.prisma
      .withWorkspace(workspaceId, APPLICATOR_UC_UID, (tx) =>
        tx.mailRuleForward.create({ data: { workspaceId, ruleId, messageId } }),
      )
      .then(() => true)
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === 'P2002') return false;
        throw err;
      });
  }

  private forwardedHeader(headers?: Record<string, string>): boolean {
    return Object.entries(headers ?? {}).some(
      ([name, value]) =>
        name.toLowerCase() === 'x-email-ops-forwarded-from' && Boolean(value.trim()),
    );
  }

  private sameAddress(left: string | null | undefined, right: string): boolean {
    return Boolean(left && left.trim().toLowerCase() === right.trim().toLowerCase());
  }

  private escapeHtml(value: string): string {
    return value.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
        character,
    );
  }

  private async createNotice(
    workspaceId: string,
    mailboxId: string,
    mailboxEmail: string,
    msg: InboundRuleMessage,
    ruleId: string,
    ruleName: string,
    note?: string,
  ): Promise<boolean> {
    const from = msg.fromAddress ?? '';
    const subject = msg.subject ?? '';
    const payload: Record<string, unknown> = {
      type: 'mail_rule_notice',
      ruleId,
      ruleName,
      mailboxId,
      mailboxAddress: mailboxEmail,
      threadId: msg.threadId,
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
      from,
      subject,
      receivedAt: msg.receivedAt ?? null,
      ...(note !== undefined ? { note } : {}),
    };
    await this.prisma.withWorkspace(workspaceId, APPLICATOR_UC_UID, (tx) =>
      tx.agentInboxItem.create({
        data: {
          workspaceId,
          messageId: null,
          smsMessageId: null,
          kind: AgentInboxKind.NOTICE,
          approvalTier: AgentInboxApprovalTier.MAILBOX_OWNER,
          draftedBy: `mail-rule:${ruleId}`,
          summary: this.truncate(`${ruleName}: ${from} · ${subject}`, 200),
          payload: payload as Prisma.InputJsonValue,
        },
      }),
    );
    return true;
  }

  private truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
  }

  /** Mailbox must exist in THIS workspace (404) and be actionable by the caller. */
  private async assertMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    opts?: { requireActive?: boolean },
  ): Promise<{ id: string; provider: string; active: boolean }> {
    const mailbox = await tx.mailboxAccount.findFirst({
      where: { id: mailboxId, workspaceId },
      select: { id: true, ownerKind: true, ownerKey: true, provider: true, active: true },
    });
    if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
    await assertMailboxVisible(tx, workspaceId, ucUid, mailbox);
    // CREATE-only fence: the inbound watcher now runs rules on active sovereign
    // AND active external (Gmail/M365) mailboxes, so only an INACTIVE mailbox
    // would make a rule a silent no-op — refuse that loudly. (Per-action
    // provider compatibility, e.g. MOVE_TO_FOLDER on external, is validated by
    // the caller which has the action list.) List/update/delete stay permissive.
    if (opts?.requireActive && !mailbox.active) {
      throw new BadRequestException(
        'Mail rules run only on active mailboxes — this mailbox is inactive.',
      );
    }
    return { id: mailbox.id, provider: mailbox.provider, active: mailbox.active };
  }

  private normalizeName(raw: string): string {
    const name = (raw ?? '').trim();
    if (name.length < 1 || name.length > 120) {
      throw new BadRequestException('name must be 1..120 characters.');
    }
    return name;
  }

  private normalizePriority(raw: number): number {
    if (!Number.isInteger(raw) || raw < 0 || raw > PRIORITY_MAX) {
      throw new BadRequestException(`priority must be an integer between 0 and ${PRIORITY_MAX}.`);
    }
    return raw;
  }

  private compileMatch(raw: unknown): MatchNode {
    const node = parseMatch(raw);
    if (this.countConditions(node) === 0) {
      throw new BadRequestException('match must contain at least one condition');
    }
    this.assertMatchShape(node);
    return node;
  }

  /**
   * Write-time structural fence for the match tree (the engine stays permissive
   * for already-stored data): exactly one mode per node, ONE level of grouping,
   * ≤5 groups, ≤10 conditions per group / top level, no empty groups. Runs on
   * the PARSED node — junk children were already dropped, so the caps count
   * what would actually be stored (same sanitize-first style as actions).
   */
  private assertMatchShape(node: MatchNode): void {
    if (node.all && node.any) {
      throw new BadRequestException(
        'match node must use either "all" or "any", not both — put the other list in a nested group',
      );
    }
    const children = node.all ?? node.any ?? [];
    const groups = children.filter((child): child is MatchNode => !('field' in child));
    if (children.length - groups.length > MAX_MATCH_CONDITIONS_PER_GROUP) {
      throw new BadRequestException(
        `match supports at most ${MAX_MATCH_CONDITIONS_PER_GROUP} conditions per group.`,
      );
    }
    if (groups.length > MAX_MATCH_GROUPS) {
      throw new BadRequestException(`match supports at most ${MAX_MATCH_GROUPS} groups.`);
    }
    for (const group of groups) {
      if (group.all && group.any) {
        throw new BadRequestException(
          'match node must use either "all" or "any", not both — put the other list in a nested group',
        );
      }
      const inner = group.all ?? group.any ?? [];
      if (inner.some((child) => !('field' in child))) {
        throw new BadRequestException(
          'match groups nest one level deep — a group may contain only conditions',
        );
      }
      if (inner.length === 0) {
        throw new BadRequestException('match groups must contain at least one condition');
      }
      if (inner.length > MAX_MATCH_CONDITIONS_PER_GROUP) {
        throw new BadRequestException(
          `match supports at most ${MAX_MATCH_CONDITIONS_PER_GROUP} conditions per group.`,
        );
      }
    }
  }

  private compileActions(raw: unknown): RuleAction[] {
    const actions = parseActions(raw).map((action) => ({
      ...action,
      ...(action.value !== undefined && (action.type === 'NOTIFY' || action.type === 'FORWARD_COPY')
        ? { value: action.value.trim() }
        : {}),
    }));
    if (actions.length === 0) {
      throw new BadRequestException('actions must contain at least one valid action');
    }
    if (actions.some((a) => a.type === 'LABEL')) {
      throw new BadRequestException('LABEL is not supported yet');
    }
    if (actions.every((a) => a.type === 'STOP')) {
      throw new BadRequestException(
        'actions must include at least one effectful action (not only STOP)',
      );
    }
    for (const action of actions) {
      if (
        action.type === 'NOTIFY' &&
        action.value !== undefined &&
        action.value.length > MAX_NOTIFY_NOTE_LENGTH
      ) {
        throw new BadRequestException(
          `NOTIFY note must be at most ${MAX_NOTIFY_NOTE_LENGTH} characters.`,
        );
      }
      if (action.type === 'FORWARD_COPY' && !action.value) {
        throw new BadRequestException(
          'FORWARD_COPY requires one destination email address in value.',
        );
      }
      if (action.type === 'FORWARD_COPY' && action.value && !EMAIL_ADDRESS_RE.test(action.value)) {
        throw new BadRequestException({
          code: 'forward_destination_not_allowed',
          message: 'FORWARD_COPY destination must be one syntactically valid email address.',
        });
      }
    }
    return actions;
  }

  /** Validate mailbox compatibility and the workspace-owned forward target. */
  private async validateActionPolicy(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailbox: { provider: string },
    actions: RuleAction[],
  ): Promise<void> {
    const forwards = actions.filter(
      (action): action is RuleAction & { type: 'FORWARD_COPY'; value: string } =>
        action.type === 'FORWARD_COPY' &&
        typeof action.value === 'string' &&
        action.value.length > 0,
    );
    if (forwards.length === 0) return;

    if (mailbox.provider !== 'stalwart') {
      throw new BadRequestException(
        'FORWARD_COPY rules are not supported on connected Gmail/Microsoft mailboxes.',
      );
    }

    const [mailboxes, domains] = await Promise.all([
      tx.mailboxAccount.findMany({ where: { workspaceId }, select: { emailAddress: true } }),
      tx.mailDomain.findMany({ where: { workspaceId }, select: { domain: true } }),
    ]);
    const allowedAddresses = new Set(mailboxes.map((row) => row.emailAddress.trim().toLowerCase()));
    const allowedDomains = domains.map((row) => row.domain.trim().toLowerCase()).filter(Boolean);
    for (const action of forwards) {
      const destination = action.value.toLowerCase();
      const at = destination.lastIndexOf('@');
      const domain = at >= 0 ? destination.slice(at + 1) : '';
      const allowed =
        allowedAddresses.has(destination) ||
        allowedDomains.some((bound) => domain === bound || domain.endsWith(`.${bound}`));
      if (!allowed) {
        throw new BadRequestException({
          code: 'forward_destination_not_allowed',
          message: `FORWARD_COPY destination ${action.value} is not a mailbox, connected account, or bound mail domain in this workspace.`,
        });
      }
    }
  }

  /** Count Condition LEAVES recursively — {} and nested-empty groups are dead rules. */
  private countConditions(node: MatchNode): number {
    const children: (Condition | MatchNode)[] = [...(node.all ?? []), ...(node.any ?? [])];
    let count = 0;
    for (const child of children) {
      if ('field' in child) count += 1;
      else count += this.countConditions(child);
    }
    return count;
  }

  private view(row: MailRule): MailRuleView {
    return {
      id: row.id,
      mailbox_id: row.mailboxId,
      name: row.name,
      enabled: row.enabled,
      priority: row.priority,
      match: parseMatch(row.match),
      actions: parseActions(row.actions),
      hit_count: row.hitCount,
      last_hit_at: row.lastHitAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
