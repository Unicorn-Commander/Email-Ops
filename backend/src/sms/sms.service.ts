import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  AgentActionKind,
  AgentInboxState,
  Prisma,
  SmsDeliveryStatus,
  SmsMode,
} from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { TwilioPort } from '../twilio/twilio.port';
import { decideComposeMode } from '../email/autonomy';
import {
  ComposeSmsInput,
  InboundSmsInput,
  InboundSmsResult,
  SmsComposeView,
  SmsInboxView,
} from './sms.types';

/**
 * SmsService — the SMS channel SoR + send path, reusing Email-Ops' governance
 * verbatim. An SMS send flows through the EXACT same controls as an email:
 *
 *   - IDEMPOTENT on (workspaceId, externalSource, externalRef) — a retry returns
 *     the existing row and sends nothing twice;
 *   - the workspace KILL SWITCH (Workspace.agentsPaused) blocks compose/send;
 *   - the AGENT registry + per-agent pause are honored;
 *   - the AUTONOMY DIAL (decideComposeMode — the same pure function email uses)
 *     decides send vs stage-for-approval (L0/L1 always stage; L2 sends, audited);
 *   - a DRAFT stages into the SAME agent-inbox queue (via smsMessageId) for human
 *     approval; a SEND hands off to the TwilioPort and is AUDITED (AgentActionEvent);
 *   - inbound SMS is recorded with the same privileged-resolve → RLS-scoped-write,
 *     idempotent-on-provider-id pattern as the email engagement webhook.
 *
 * Every method runs inside withWorkspace(workspaceId, ucUid, …) — the GUC
 * chokepoint — so Postgres RLS scopes every SMS row to its workspace under the
 * NOBYPASSRLS runtime role. The provider is the injected TwilioPort (degrade-clean):
 * nothing throws when SMS is unconfigured (the row records FAILED).
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  /**
   * Provenance sources trusted to send WITHOUT a registered agent — the SAME
   * knob EmailService uses (one first-party federation allowlist for both
   * channels), so an unregistered-but-trusted cockpit (e.g. Customer-Ops) sends
   * while an unknown/spoofed source is fail-safed to a staged draft.
   */
  private readonly trustedComposeSources = new Set(
    (process.env.EMAIL_OPS_TRUSTED_COMPOSE_SOURCES ?? 'email-ops-client,customer-ops')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioPort,
  ) {}

  // ── compose (idempotent; autonomy-gated; kill-switch-fenced) ────────────

  async composeSms(
    workspaceId: string,
    ucUid: string | null,
    input: ComposeSmsInput,
  ): Promise<SmsComposeView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      // Idempotency: a repeat (workspace, source, ref) returns the existing row.
      const existing = await tx.smsMessage.findUnique({
        where: {
          workspaceId_externalSource_externalRef: {
            workspaceId,
            externalSource: input.externalSource,
            externalRef: input.externalRef,
          },
        },
      });
      if (existing) {
        this.logger.log(
          `compose_sms idempotent hit for (${workspaceId}, ${input.externalSource}, ${input.externalRef}) — returning existing sms ${existing.id} (no second send)`,
        );
        return this.composeView(existing);
      }

      // Workspace kill switch.
      const ws = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { agentsPaused: true },
      });
      if (ws?.agentsPaused) {
        this.logger.log(`compose_sms blocked: agents paused for workspace ${workspaceId}`);
        throw new ForbiddenException('Agents are paused for this workspace.');
      }

      // Agent resolution + per-agent kill switch.
      const agentKey = input.draftedBy ?? input.externalSource;
      const agent = agentKey
        ? await tx.agent.findFirst({
            where: { workspaceId, key: agentKey, active: true },
            select: { key: true, autonomyLevel: true, recipientPolicy: true, paused: true },
          })
        : null;
      if (agent?.paused) {
        this.logger.log(`compose_sms blocked: agent '${agentKey}' is paused (workspace ${workspaceId})`);
        throw new ForbiddenException(`Agent '${agentKey}' is paused.`);
      }

      // Send-from line: an explicit account (scoped to the workspace), else the default.
      const account = await this.resolveSendAccount(tx, workspaceId, input.fromSmsAccountId);
      const fromPhoneNumber = account?.phoneNumber ?? null;

      // The autonomy dial — the SAME pure decision email uses. (For SMS the
      // recipient is a phone, which has no internal domain, so the L2
      // external-recipient guard defaults to the SAFE side: approval.) For an
      // UNREGISTERED provenance, a 'send' is honored only from a TRUSTED
      // first-party source — mirroring composeEmail's injection guard.
      const trustedUnregisteredSend =
        !agent && (agentKey == null || this.trustedComposeSources.has(agentKey));
      const decision = decideComposeMode({
        requestedMode: input.mode === 'draft' ? 'draft' : 'send',
        agent,
        toAddress: input.toPhoneNumber,
        trustedUnregisteredSend,
      });
      const mode = decision.mode === 'draft' ? SmsMode.DRAFT : SmsMode.SEND;
      if (decision.coerced) {
        this.logger.log(
          `compose_sms autonomy gate: agent '${agentKey}' send→draft (${decision.reason}) — staged for approval (workspace ${workspaceId})`,
        );
      } else if (mode === SmsMode.SEND && agent) {
        this.logger.log(
          `compose_sms autonomy: agent '${agentKey}' autonomous send (${decision.reason}, audited) (workspace ${workspaceId})`,
        );
      }

      // ── DRAFT: stage into the shared agent-inbox; never sends.
      if (mode === SmsMode.DRAFT) {
        const msg = await tx.smsMessage.create({
          data: {
            workspaceId,
            smsAccountId: account?.id ?? null,
            contactId: input.contactId ?? null,
            threadId: input.inReplyToThreadId ?? null,
            externalSource: input.externalSource,
            externalRef: input.externalRef,
            mode: SmsMode.DRAFT,
            status: SmsDeliveryStatus.PENDING_APPROVAL,
            direction: 'DRAFT',
            fromPhoneNumber,
            toPhoneNumber: input.toPhoneNumber,
            body: input.body,
            preview: this.snippet(input.body),
            actorUcUid: ucUid,
          },
        });
        await tx.agentInboxItem.create({
          data: {
            workspaceId,
            smsMessageId: msg.id,
            draftedBy: agentKey,
            summary: this.summary(input.body, input.toPhoneNumber),
          },
        });
        this.logger.log(
          `compose_sms DRAFT staged into agent-inbox: sms ${msg.id} (workspace ${workspaceId}) pending human approval`,
        );
        await this.recordAction(tx, workspaceId, {
          kind: AgentActionKind.STAGED_FOR_APPROVAL,
          agentKey,
          messageId: msg.id,
          actorUcUid: ucUid,
          detail: decision.coerced ? `SMS staged by dial (${decision.reason})` : `SMS → ${input.toPhoneNumber}`,
        });
        return this.composeView(msg);
      }

      // ── SEND: record QUEUED, hand to Twilio, audit (if an agent).
      const msg = await tx.smsMessage.create({
        data: {
          workspaceId,
          smsAccountId: account?.id ?? null,
          contactId: input.contactId ?? null,
          threadId: input.inReplyToThreadId ?? null,
          externalSource: input.externalSource,
          externalRef: input.externalRef,
          mode: SmsMode.SEND,
          status: SmsDeliveryStatus.QUEUED,
          direction: 'SENT',
          fromPhoneNumber,
          toPhoneNumber: input.toPhoneNumber,
          body: input.body,
          preview: this.snippet(input.body),
          actorUcUid: ucUid,
        },
      });
      const sent = await this.handToTwilio(tx, msg.id, {
        fromPhoneNumber: fromPhoneNumber ?? '',
        toPhoneNumber: input.toPhoneNumber,
        body: input.body,
      });
      if (agent) {
        await this.recordAction(tx, workspaceId, {
          kind: AgentActionKind.AUTONOMOUS_SEND,
          agentKey: agent.key,
          messageId: msg.id,
          actorUcUid: ucUid,
          detail: `SMS → ${input.toPhoneNumber} (${this.statusWire(sent.status)})`,
        });
      }
      return this.composeView(sent);
    });
  }

  // ── the agent-inbox (SMS items) ─────────────────────────────────────────

  async listSmsInbox(
    workspaceId: string,
    ucUid: string | null,
    state?: AgentInboxState,
  ): Promise<SmsInboxView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const items = await tx.agentInboxItem.findMany({
        where: { smsMessageId: { not: null }, ...(state ? { state } : { state: AgentInboxState.PENDING }) },
        orderBy: { createdAt: 'desc' },
        include: { smsMessage: true },
      });
      return items.map((it) => this.inboxView(it, it.smsMessage));
    });
  }

  /** Approve a staged SMS draft: PENDING → APPROVED, hand to Twilio, audit. */
  async approveSmsInboxItem(
    workspaceId: string,
    ucUid: string | null,
    itemId: string,
    note?: string | null,
  ): Promise<{ inbox: SmsInboxView; message: SmsComposeView | null } | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      // Tenant fence: scope by workspaceId so a foreign id resolves null (→ 404).
      const item = await tx.agentInboxItem.findFirst({
        where: { id: itemId, workspaceId, smsMessageId: { not: null } },
        include: { smsMessage: true },
      });
      if (!item || !item.smsMessage) return null;
      if (item.state !== AgentInboxState.PENDING) {
        return { inbox: this.inboxView(item, item.smsMessage), message: this.composeView(item.smsMessage) };
      }

      const sent = await this.handToTwilio(tx, item.smsMessage.id, {
        fromPhoneNumber: item.smsMessage.fromPhoneNumber ?? '',
        toPhoneNumber: item.smsMessage.toPhoneNumber ?? '',
        body: item.smsMessage.body ?? '',
      });
      const updated = await tx.agentInboxItem.update({
        where: { id: itemId },
        data: {
          state: AgentInboxState.APPROVED,
          reviewedByUcUid: ucUid,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
        include: { smsMessage: true },
      });
      this.logger.log(
        `agent-inbox SMS item ${itemId} APPROVED by ${ucUid ?? '(unknown)'} — draft handed to Twilio (sms ${item.smsMessage.id})`,
      );
      await this.recordAction(tx, workspaceId, {
        kind: AgentActionKind.APPROVED,
        agentKey: item.draftedBy,
        messageId: item.smsMessage.id,
        actorUcUid: ucUid,
        detail: `SMS → ${item.smsMessage.toPhoneNumber ?? '?'}`,
      });
      return { inbox: this.inboxView(updated, sent), message: this.composeView(sent) };
    });
  }

  /** Reject a staged SMS draft: PENDING → REJECTED; the message never leaves. */
  async rejectSmsInboxItem(
    workspaceId: string,
    ucUid: string | null,
    itemId: string,
    note?: string | null,
  ): Promise<SmsInboxView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const item = await tx.agentInboxItem.findFirst({
        where: { id: itemId, workspaceId, smsMessageId: { not: null } },
        include: { smsMessage: true },
      });
      if (!item || !item.smsMessage) return null;
      if (item.state !== AgentInboxState.PENDING) {
        return this.inboxView(item, item.smsMessage);
      }

      await tx.smsMessage.update({
        where: { id: item.smsMessage.id },
        data: { status: SmsDeliveryStatus.REJECTED },
      });
      const updated = await tx.agentInboxItem.update({
        where: { id: itemId },
        data: {
          state: AgentInboxState.REJECTED,
          reviewedByUcUid: ucUid,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
        include: { smsMessage: true },
      });
      this.logger.log(`agent-inbox SMS item ${itemId} REJECTED by ${ucUid ?? '(unknown)'} — never sent`);
      await this.recordAction(tx, workspaceId, {
        kind: AgentActionKind.REJECTED,
        agentKey: item.draftedBy,
        messageId: item.smsMessage.id,
        actorUcUid: ucUid,
        detail: note ?? null,
      });
      return this.inboxView(updated, updated.smsMessage);
    });
  }

  // ── inbound (Twilio webhook → SoR), provider-authed + idempotent ────────

  /**
   * Record an inbound SMS. Mirrors the email engagement-capture RLS pattern: a
   * provider webhook arrives WORKSPACE-AGNOSTIC, so (1) a MINIMAL privileged
   * resolve maps the inbound line (toPhoneNumber) → owning workspace, then (2) the
   * actual write runs inside withWorkspace(resolved). Idempotent on the Twilio
   * MessageSid: a re-delivery is a clean no-op.
   */
  async recordInboundSms(input: InboundSmsInput): Promise<InboundSmsResult> {
    // 1. Privileged resolve: which workspace owns the line it came in on?
    // Uses PrismaService.systemClient (ADMIN_DATABASE_URL / BYPASSRLS). The
    // follow-on write below remains fenced by withWorkspace(account.workspaceId).
    const account = await this.prisma.systemClient.smsAccount.findFirst({
      where: { phoneNumber: input.toPhoneNumber, active: true },
      select: { id: true, workspaceId: true },
    });
    if (!account) {
      this.logger.warn(
        `recordInboundSms: no SMS account for toPhoneNumber=${input.toPhoneNumber} — ACKing as unmatched (not ours)`,
      );
      return { outcome: 'unmatched', workspaceId: null, smsMessageId: null };
    }

    // 2. RLS-scoped write, idempotent on the provider id.
    return this.prisma.withWorkspace(account.workspaceId, null, async (tx) => {
      const already = await tx.smsMessage.findFirst({
        where: { providerMessageId: input.providerMessageId, direction: 'RECEIVED' },
        select: { id: true },
      });
      if (already) {
        return { outcome: 'duplicate' as const, workspaceId: account.workspaceId, smsMessageId: already.id };
      }
      try {
        const msg = await tx.smsMessage.create({
          data: {
            workspaceId: account.workspaceId,
            smsAccountId: account.id,
            mode: SmsMode.SEND,
            status: SmsDeliveryStatus.DELIVERED,
            direction: 'RECEIVED',
            fromPhoneNumber: input.fromPhoneNumber,
            toPhoneNumber: input.toPhoneNumber,
            body: input.body,
            preview: this.snippet(input.body),
            providerMessageId: input.providerMessageId,
            receivedAt: input.occurredAt ?? new Date(),
          },
        });
        return { outcome: 'recorded' as const, workspaceId: account.workspaceId, smsMessageId: msg.id };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const dup = await tx.smsMessage.findFirst({
            where: { providerMessageId: input.providerMessageId, direction: 'RECEIVED' },
            select: { id: true },
          });
          return { outcome: 'duplicate' as const, workspaceId: account.workspaceId, smsMessageId: dup?.id ?? null };
        }
        throw err;
      }
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async resolveSendAccount(
    tx: WorkspaceTxClient,
    workspaceId: string,
    explicitId?: string | null,
  ): Promise<{ id: string; phoneNumber: string } | null> {
    if (explicitId) {
      const explicit = await tx.smsAccount.findFirst({
        where: { id: explicitId, workspaceId, active: true },
        select: { id: true, phoneNumber: true },
      });
      if (explicit) return explicit;
    }
    return tx.smsAccount.findFirst({
      where: { workspaceId, active: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, phoneNumber: true },
    });
  }

  private async handToTwilio(
    tx: WorkspaceTxClient,
    messageId: string,
    req: { fromPhoneNumber: string; toPhoneNumber: string; body: string },
  ) {
    const result = await this.twilio.send(req);
    const status = result.accepted ? SmsDeliveryStatus.SENT : SmsDeliveryStatus.FAILED;
    if (!result.accepted) {
      this.logger.warn(
        `sms ${messageId} send NOT accepted by Twilio (lane=${result.lane ?? 'none'}): ${result.reason ?? 'unknown'} — recorded FAILED (degrade-clean)`,
      );
    }
    return tx.smsMessage.update({
      where: { id: messageId },
      data: {
        status,
        providerMessageId: result.providerMessageId,
        sentAt: result.accepted ? new Date() : null,
      },
    });
  }

  private async recordAction(
    tx: WorkspaceTxClient,
    workspaceId: string,
    data: { kind: AgentActionKind; agentKey?: string | null; messageId?: string | null; actorUcUid?: string | null; detail?: string | null },
  ): Promise<void> {
    await tx.agentActionEvent.create({
      data: {
        workspaceId,
        kind: data.kind,
        agentKey: data.agentKey ?? null,
        messageId: data.messageId ?? null,
        actorUcUid: data.actorUcUid ?? null,
        detail: data.detail ?? null,
      },
    });
  }

  private composeView(m: {
    id: string;
    threadId: string | null;
    status: SmsDeliveryStatus;
    mode: SmsMode;
    toPhoneNumber: string | null;
    externalSource: string | null;
    externalRef: string | null;
    createdAt: Date;
  }): SmsComposeView {
    return {
      id: m.id,
      channel: 'sms',
      thread_id: m.threadId ?? null,
      status: this.statusWire(m.status),
      mode: m.mode.toLowerCase(),
      to: m.toPhoneNumber ?? null,
      external_source: m.externalSource ?? null,
      external_ref: m.externalRef ?? null,
      created_at: m.createdAt ? m.createdAt.toISOString() : null,
    };
  }

  private inboxView(
    it: {
      id: string;
      smsMessageId: string | null;
      state: AgentInboxState;
      draftedBy: string | null;
      summary: string | null;
      reviewedByUcUid: string | null;
      reviewedAt: Date | null;
      reviewNote: string | null;
      createdAt: Date;
    },
    msg: { toPhoneNumber: string | null; body?: string | null; preview?: string | null } | null,
  ): SmsInboxView {
    return {
      id: it.id,
      sms_message_id: it.smsMessageId,
      channel: 'sms',
      state: it.state.toLowerCase(),
      drafted_by: it.draftedBy ?? null,
      summary: it.summary ?? null,
      to: msg?.toPhoneNumber ?? null,
      body_preview: msg ? msg.preview ?? this.snippet(msg.body) : null,
      reviewed_by_uc_uid: it.reviewedByUcUid ?? null,
      reviewed_at: it.reviewedAt ? it.reviewedAt.toISOString() : null,
      review_note: it.reviewNote ?? null,
      created_at: it.createdAt ? it.createdAt.toISOString() : null,
    };
  }

  private statusWire(status: SmsDeliveryStatus): string {
    return status.toLowerCase();
  }

  private snippet(body: string | null | undefined): string | null {
    if (!body) return null;
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
  }

  private summary(body: string | null | undefined, to: string | null | undefined): string {
    const s = this.snippet(body) || '(empty)';
    return to ? `SMS → ${to}: ${s}` : `SMS: ${s}`;
  }
}
