/**
 * EmailService — the Email-Ops system-of-record + the EmailOpsPort contract +
 * the agent-inbox approval flow.
 *
 * This is the ONE implementation both the MCP contract tools and (future) REST
 * surface delegate to, so an agent and a human hit one set of rules + one RLS
 * path. Every method runs inside `withWorkspace(workspaceId, ucUid, …)` — the
 * GUC chokepoint — so Postgres RLS scopes every row to the workspace the moment
 * the runtime flips to the NOBYPASSRLS email_ops_app role. The mailbox engine is
 * the injected StalwartPort (degrade-clean): reads federate Stalwart; sends route
 * Stalwart/Postmark; nothing throws when the engine is unconfigured.
 *
 * The three contract behaviors (matching Customer-Ops' EmailOpsPort):
 *   1. listThreadsWithContact — the live mailbox threads with a contact
 *      (federated from Stalwart) UNION the workspace's own outbound thread rows
 *      (the SoR), deduped by thread id. Read-only / viewer-level.
 *   2. listThreadMessages — the messages in a thread (Stalwart previews UNION
 *      the SoR outbound rows). Read-only / viewer-level.
 *   3. composeEmail — IDEMPOTENT on (workspaceId, externalSource, externalRef):
 *        - mode=send  → record the SoR row, hand to the mail engine, set status
 *          from the engine result (queued/sent/failed).
 *        - mode=draft → record the SoR row in status PENDING_APPROVAL and stage
 *          an AgentInboxItem (PENDING). The send happens later on approve().
 *      A repeat with the same tuple returns the EXISTING message, queues NO
 *      second send.
 *
 * The agent-inbox approval flow:
 *   - listAgentInbox(state?) — the queue (pending by default).
 *   - approveAgentInboxItem — PENDING → APPROVED, hand the staged draft to the
 *     send lane, advance the message to queued/sent/failed.
 *   - rejectAgentInboxItem  — PENDING → REJECTED; the message is marked REJECTED
 *     and never leaves.
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  AgentActionKind,
  AgentInboxKind,
  AgentInboxState,
  EmailDirection,
  EmailMessageStatus,
  EmailMode,
  Prisma,
} from '@prisma/client';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartThread } from '../stalwart/stalwart.types';
import {
  AgentInboxView,
  ComposeInput,
  EngagementCaptureInput,
  EngagementCaptureResult,
  MessageComposeView,
  MessageView,
  ThreadView,
} from './email.types';
import { shouldAdvanceStatus } from './message-status';
import { decideComposeMode } from './autonomy';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
    private readonly connectedAccounts: ConnectedAccountsService,
  ) {}

  // ── status mapping ─────────────────────────────────────────────────────

  private statusWire(status: EmailMessageStatus): string {
    return status.toLowerCase();
  }

  private modeWire(mode: EmailMode): string {
    return mode.toLowerCase();
  }

  // ── 1. list_threads_with_contact ───────────────────────────────────────

  /**
   * The mailbox threads with a contact: the live Stalwart threads (when the
   * engine is configured) UNION the workspace's own outbound thread rows (the
   * SoR), deduped by thread id, newest-first. Viewer-level (no dual SKU).
   */
  async listThreadsWithContact(
    workspaceId: string,
    ucUid: string | null,
    contactId: string,
  ): Promise<ThreadView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      // The deliverable address + default mailbox for the workspace (if any).
      const mailbox = await this.defaultMailbox(tx);
      const address = await this.contactAddress(tx, contactId);

      // Live Stalwart threads (degrade-clean: [] when unconfigured).
      let live: StalwartThread[] = [];
      if (mailbox && address) {
        live = await this.stalwart.listThreads(mailbox.emailAddress, address);
      }

      // The workspace's own outbound SoR rows for this contact, projected as
      // thin threads (so a brand-new outbound the cockpit just composed shows in
      // the 360 even before the engine surfaces it).
      const own = await tx.emailMessage.findMany({
        where: { contactId, threadId: { not: null } },
        orderBy: { createdAt: 'desc' },
      });

      const byThread = new Map<string, ThreadView>();
      for (const t of live) {
        byThread.set(t.id, {
          id: t.id,
          subject: t.subject,
          message_count: t.messageCount,
          unread: t.unread,
          last_message_at: t.lastMessageAt,
          last_snippet: t.lastSnippet,
          participants: t.participants.map((p) => ({ address: p.address, name: p.name })),
        });
      }
      for (const m of own) {
        const tid = m.threadId as string;
        if (byThread.has(tid)) continue; // live thread wins (richer).
        byThread.set(tid, {
          id: tid,
          subject: m.subject ?? null,
          message_count: 1,
          unread: false,
          last_message_at: (m.sentAt ?? m.createdAt)?.toISOString() ?? null,
          last_snippet: m.preview ?? this.snippet(m.body),
          participants: [
            ...(m.fromAddress ? [{ address: m.fromAddress, name: null }] : []),
            ...(m.toAddress ? [{ address: m.toAddress, name: null }] : []),
          ],
        });
      }
      return [...byThread.values()];
    });
  }

  // ── 2. list_thread_messages ────────────────────────────────────────────

  /**
   * The messages in a thread: live Stalwart previews UNION the SoR outbound
   * rows, deduped by message id, oldest-first. Viewer-level.
   */
  async listThreadMessages(
    workspaceId: string,
    ucUid: string | null,
    threadId: string,
  ): Promise<MessageView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await this.defaultMailbox(tx);

      let live: MessageView[] = [];
      if (mailbox) {
        const msgs = await this.stalwart.listMessages(mailbox.emailAddress, threadId);
        live = msgs.map((m) => ({
          id: m.id,
          thread_id: m.threadId,
          from: m.from ? { address: m.from.address, name: m.from.name } : null,
          to: m.to.map((p) => ({ address: p.address, name: p.name })),
          subject: m.subject,
          sent_at: m.sentAt,
          preview: m.preview,
          direction: m.direction,
        }));
      }

      const own = await tx.emailMessage.findMany({
        where: { threadId },
        orderBy: { createdAt: 'asc' },
      });

      const byId = new Map<string, MessageView>();
      for (const m of live) byId.set(m.id, m);
      for (const m of own) {
        if (byId.has(m.id)) continue;
        byId.set(m.id, {
          id: m.id,
          thread_id: m.threadId ?? threadId,
          from: m.fromAddress ? { address: m.fromAddress, name: null } : null,
          to: m.toAddress ? [{ address: m.toAddress, name: null }] : [],
          subject: m.subject ?? null,
          sent_at: (m.sentAt ?? m.createdAt)?.toISOString() ?? null,
          preview: m.preview ?? this.snippet(m.body),
          direction: m.direction.toLowerCase(),
        });
      }
      return [...byId.values()];
    });
  }

  /**
   * The mailbox's recent threads — the human email client's inbox list. Engine
   * receives light up when the engine is live; until then this is the SoR view
   * (threads this mailbox has sent), so the client is honest rather than empty-
   * by-bug. Workspace-scoped.
   */
  async listMailboxInbox(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    limit = 50,
  ): Promise<ThreadView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await tx.mailboxAccount.findFirst({ where: { id: mailboxId, workspaceId } });
      if (!mailbox) return [];

      const msgs = await tx.emailMessage.findMany({
        where: { fromAddress: mailbox.emailAddress, threadId: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 300,
      });

      const byThread = new Map<
        string,
        {
          id: string;
          subject: string | null;
          count: number;
          last: Date;
          snippet: string | null;
          participants: Set<string>;
        }
      >();
      for (const m of msgs) {
        const tid = m.threadId as string;
        const when = m.sentAt ?? m.createdAt ?? new Date(0);
        const cur = byThread.get(tid);
        if (!cur) {
          byThread.set(tid, {
            id: tid,
            subject: m.subject ?? null,
            count: 1,
            last: when,
            snippet: m.preview ?? this.snippet(m.body),
            participants: new Set([m.toAddress].filter((a): a is string => !!a)),
          });
        } else {
          cur.count += 1;
          if (m.toAddress) cur.participants.add(m.toAddress);
          if (when.getTime() > cur.last.getTime()) {
            cur.last = when;
            cur.snippet = m.preview ?? this.snippet(m.body);
            cur.subject = cur.subject ?? m.subject ?? null;
          }
        }
      }

      return [...byThread.values()]
        .sort((a, b) => b.last.getTime() - a.last.getTime())
        .slice(0, limit)
        .map((t) => ({
          id: t.id,
          subject: t.subject,
          message_count: t.count,
          unread: false,
          last_message_at: t.last.toISOString(),
          last_snippet: t.snippet,
          participants: [...t.participants].map((address) => ({ address, name: null })),
        }));
    });
  }

  // ── 3. compose_email (idempotent; send vs draft) ───────────────────────

  /**
   * Compose an outbound email. IDEMPOTENT on (workspaceId, externalSource,
   * externalRef): a repeat returns the EXISTING message and queues NO second
   * send. mode=send hands to the mail engine; mode=draft stages the agent-inbox.
   */
  async composeEmail(
    workspaceId: string,
    ucUid: string | null,
    input: ComposeInput,
  ): Promise<MessageComposeView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      // Idempotency: a prior row with the same tuple returns unchanged.
      const existing = await tx.emailMessage.findUnique({
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
          `compose_email idempotent hit for (${workspaceId}, ${input.externalSource}, ${input.externalRef}) — returning existing message ${existing.id} (no second send)`,
        );
        return this.composeView(existing);
      }

      // Kill switch: when the workspace is paused, agents cannot compose/send.
      // (An idempotent repeat above still returns; a human approving an already-
      // staged draft is a separate path and stays unaffected.)
      const ws = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { agentsPaused: true },
      });
      if (ws?.agentsPaused) {
        this.logger.log(`compose_email blocked: agents paused for workspace ${workspaceId}`);
        throw new ForbiddenException('Agents are paused for this workspace.');
      }

      // Resolve the registered agent that drafted this (by its provenance key).
      const agentKey = input.draftedBy ?? input.externalSource;
      const agent = agentKey
        ? await tx.agent.findFirst({
            where: { workspaceId, key: agentKey, active: true },
            select: {
              key: true,
              autonomyLevel: true,
              recipientPolicy: true,
              mailboxAccountId: true,
              paused: true,
            },
          })
        : null;

      // Per-agent kill switch: this ONE agent is paused (distinct from the
      // workspace-wide pause above, which freezes the whole fleet).
      if (agent?.paused) {
        this.logger.log(`compose_email blocked: agent '${agentKey}' is paused (workspace ${workspaceId})`);
        throw new ForbiddenException(`Agent '${agentKey}' is paused.`);
      }

      // Send identity: a registered agent sends from its OWN primary mailbox
      // (cached on Agent.mailboxAccountId = the isPrimary binding); an unregistered
      // agent falls back to the workspace default (legacy, unchanged). Fixes the
      // latent bug where an agent with a mailbox still sent from the ws default.
      // An explicit from-mailbox (the human client picks which inbox to send as)
      // wins when it's in-workspace; otherwise resolve the agent/default identity.
      const explicitFrom = input.fromMailboxAccountId
        ? await tx.mailboxAccount.findFirst({
            where: { id: input.fromMailboxAccountId, workspaceId },
          })
        : null;
      const mailbox = explicitFrom ?? (await this.resolveSendMailbox(tx, workspaceId, agent));
      const fromAddress = mailbox?.emailAddress ?? null;

      // Enforce the autonomy dial — gate send-vs-draft by the agent's level +
      // recipient policy. Opt-in + conservative: an UNREGISTERED agent keeps the
      // legacy behavior, and the decision only ever makes a send MORE gated.
      const decision = decideComposeMode({
        requestedMode: input.mode === 'draft' ? 'draft' : 'send',
        agent,
        toAddress: input.toAddress,
      });
      const mode = decision.mode === 'draft' ? EmailMode.DRAFT : EmailMode.SEND;
      if (decision.coerced) {
        this.logger.log(
          `compose_email autonomy gate: agent '${agentKey}' send→draft (${decision.reason}) — staged for approval (workspace ${workspaceId})`,
        );
      } else if (mode === EmailMode.SEND && agent) {
        this.logger.log(
          `compose_email autonomy: agent '${agentKey}' autonomous send (${decision.reason}, audited) (workspace ${workspaceId})`,
        );
      }

      if (mode === EmailMode.DRAFT) {
        // Stage the draft into the agent-inbox approval surface.
        const msg = await tx.emailMessage.create({
          data: {
            workspaceId,
            mailboxAccountId: mailbox?.id ?? null,
            contactId: input.contactId,
            threadId: input.inReplyToThreadId ?? null,
            inReplyToThreadId: input.inReplyToThreadId ?? null,
            externalSource: input.externalSource,
            externalRef: input.externalRef,
            mode: EmailMode.DRAFT,
            status: EmailMessageStatus.PENDING_APPROVAL,
            direction: EmailDirection.DRAFT,
            fromAddress,
            toAddress: input.toAddress,
            subject: input.subject,
            body: input.body,
            preview: this.snippet(input.body),
            actorUcUid: ucUid,
          },
        });
        await tx.agentInboxItem.create({
          data: {
            workspaceId,
            messageId: msg.id,
            state: AgentInboxState.PENDING,
            draftedBy: input.draftedBy ?? input.externalSource,
            summary: this.summary(input.subject, input.toAddress),
          },
        });
        this.logger.log(
          `compose_email DRAFT staged into agent-inbox: message ${msg.id} (workspace ${workspaceId}) pending human approval`,
        );
        await this.recordAction(tx, workspaceId, {
          kind: AgentActionKind.STAGED_FOR_APPROVAL,
          agentKey: input.draftedBy ?? input.externalSource,
          messageId: msg.id,
          actorUcUid: ucUid,
          detail: decision.coerced ? `staged by dial (${decision.reason})` : (input.subject ?? null),
        });
        return this.composeView(msg);
      }

      // mode=send — record the SoR row, then hand to the mail engine.
      const msg = await tx.emailMessage.create({
        data: {
          workspaceId,
          mailboxAccountId: mailbox?.id ?? null,
          contactId: input.contactId,
          threadId: input.inReplyToThreadId ?? null,
          inReplyToThreadId: input.inReplyToThreadId ?? null,
          externalSource: input.externalSource,
          externalRef: input.externalRef,
          mode: EmailMode.SEND,
          status: EmailMessageStatus.QUEUED,
          direction: EmailDirection.SENT,
          fromAddress,
          toAddress: input.toAddress,
          subject: input.subject,
          body: input.body,
          preview: this.snippet(input.body),
          actorUcUid: ucUid,
        },
      });

      const sent = await this.handToEngine(tx, msg.id, {
        fromAddress: fromAddress ?? input.toAddress, // engine requires a From; degrade-safe
        fromName: mailbox?.displayName ?? null,
        toAddress: input.toAddress,
        subject: input.subject,
        body: input.body,
        inReplyToThreadId: input.inReplyToThreadId ?? null,
        transactional: mailbox?.postmarkLane ?? true,
      });
      if (agent) {
        // A registered agent reaching the send lane is an L2 autonomous send
        // (the gate coerces L0/L1 sends to drafts) — audit it WITH its outcome.
        // handToEngine is degrade-clean (a rejected send returns FAILED rather
        // than throwing), so stamp the result so the feed never reads a failed
        // autonomous send as a delivered one.
        await this.recordAction(tx, workspaceId, {
          kind: AgentActionKind.AUTONOMOUS_SEND,
          agentKey: agent.key,
          messageId: msg.id,
          actorUcUid: ucUid,
          detail: `${input.subject ?? '(no subject)'} (${this.statusWire(sent.status)})`,
        });
      }
      return this.composeView(sent);
    });
  }

  // ── agent-inbox: list / approve / reject ───────────────────────────────

  /** The agent-inbox queue (PENDING by default), newest-first. */
  async listAgentInbox(
    workspaceId: string,
    ucUid: string | null,
    state?: AgentInboxState,
  ): Promise<AgentInboxView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const items = await tx.agentInboxItem.findMany({
        where: state ? { state } : { state: AgentInboxState.PENDING },
        orderBy: { createdAt: 'desc' },
        include: { message: true },
      });
      return items.map((it) => this.inboxView(it, it.message));
    });
  }

  /**
   * Approve a pending agent-inbox draft: PENDING → APPROVED, hand the staged
   * draft to the send lane, advance the message to queued/sent/failed. Returns
   * the updated message view. Idempotent-ish: approving a non-pending item is a
   * no-op that returns the current message view.
   */
  async approveAgentInboxItem(
    workspaceId: string,
    ucUid: string | null,
    itemId: string,
    note?: string | null,
  ): Promise<{ inbox: AgentInboxView; message: MessageComposeView | null } | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const item = await tx.agentInboxItem.findUnique({
        where: { id: itemId },
        include: { message: true },
      });
      if (!item) return null;
      if (item.state !== AgentInboxState.PENDING) {
        return {
          inbox: this.inboxView(item, item.message),
          message: item.kind === AgentInboxKind.EMAIL && item.message ? this.composeView(item.message) : null,
        };
      }

      if (item.kind === AgentInboxKind.CLEANUP) {
        const payload = this.cleanupPayload(item.payload);
        const owner = await this.resolveUserByUcUid(tx, ucUid);
        if (!owner) return null;
        const batchId = payload.batch_id;
        if (!batchId || typeof batchId !== 'string') return null;

        const executed = await this.connectedAccounts.approveCleanupBatch(workspaceId, owner, batchId);
        if (!executed) return null;

        const updated = await tx.agentInboxItem.update({
          where: { id: itemId },
          data: {
            state: AgentInboxState.APPROVED,
            reviewedByUcUid: ucUid,
            reviewedAt: new Date(),
            reviewNote: note ?? null,
          },
          include: { message: true },
        });
        this.logger.log(
          `agent-inbox cleanup item ${itemId} APPROVED by ${ucUid ?? '(unknown)'} — cleanup batch ${batchId} executed`,
        );
        return { inbox: this.inboxView(updated, null), message: null };
      }

      if (!item.message) return null;

      const mailbox = item.message.mailboxAccountId
        ? await tx.mailboxAccount.findUnique({ where: { id: item.message.mailboxAccountId } })
        : await this.defaultMailbox(tx);

      // Hand the approved draft to the mail engine.
      const sent = await this.handToEngine(tx, item.message.id, {
        fromAddress: item.message.fromAddress ?? mailbox?.emailAddress ?? item.message.toAddress!,
        fromName: mailbox?.displayName ?? null,
        toAddress: item.message.toAddress!,
        subject: item.message.subject ?? '',
        body: item.message.body ?? '',
        inReplyToThreadId: item.message.inReplyToThreadId ?? null,
        transactional: mailbox?.postmarkLane ?? true,
      });

      const updated = await tx.agentInboxItem.update({
        where: { id: itemId },
        data: {
          state: AgentInboxState.APPROVED,
          reviewedByUcUid: ucUid,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
        include: { message: true },
      });
      this.logger.log(
        `agent-inbox item ${itemId} APPROVED by ${ucUid ?? '(unknown)'} — draft handed to send lane (message ${item.message.id})`,
      );
      await this.recordAction(tx, workspaceId, {
        kind: AgentActionKind.APPROVED,
        agentKey: item.draftedBy,
        messageId: item.message.id,
        actorUcUid: ucUid,
        detail: item.message.subject ?? null,
      });
      return { inbox: this.inboxView(updated, sent), message: this.composeView(sent) };
    });
  }

  /**
   * Reject a pending agent-inbox draft: PENDING → REJECTED; the message is
   * marked REJECTED and never leaves. No-op (returns current) if not pending.
   */
  async rejectAgentInboxItem(
    workspaceId: string,
    ucUid: string | null,
    itemId: string,
    note?: string | null,
  ): Promise<{ inbox: AgentInboxView; message: MessageComposeView | null } | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const item = await tx.agentInboxItem.findUnique({
        where: { id: itemId },
        include: { message: true },
      });
      if (!item) return null;
      if (item.state !== AgentInboxState.PENDING) {
        return {
          inbox: this.inboxView(item, item.message),
          message: item.kind === AgentInboxKind.EMAIL && item.message ? this.composeView(item.message) : null,
        };
      }
      if (item.kind === AgentInboxKind.CLEANUP) {
        const payload = this.cleanupPayload(item.payload);
        const updated = await tx.agentInboxItem.update({
          where: { id: itemId },
          data: {
            state: AgentInboxState.REJECTED,
            reviewedByUcUid: ucUid,
            reviewedAt: new Date(),
            reviewNote: note ?? null,
          },
          include: { message: true },
        });
        return { inbox: this.inboxView(updated, null), message: null };
      }
      if (!item.message) return null;
      const msg = await tx.emailMessage.update({
        where: { id: item.message.id },
        data: { status: EmailMessageStatus.REJECTED },
      });
      const updated = await tx.agentInboxItem.update({
        where: { id: itemId },
        data: {
          state: AgentInboxState.REJECTED,
          reviewedByUcUid: ucUid,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
      });
      this.logger.log(
        `agent-inbox item ${itemId} REJECTED by ${ucUid ?? '(unknown)'} — message ${item.messageId} will not be sent`,
      );
      await this.recordAction(tx, workspaceId, {
        kind: AgentActionKind.REJECTED,
        agentKey: item.draftedBy,
        messageId: item.message.id,
        actorUcUid: ucUid,
        detail: item.message.subject ?? null,
      });
      return { inbox: this.inboxView(updated, msg), message: this.composeView(msg) };
    });
  }

  /**
   * The mailbox an agent sends FROM. A registered agent uses its OWN primary
   * mailbox (the isPrimary AgentMailbox binding, cached on Agent.mailboxAccountId);
   * an unregistered agent / one with no mailbox falls back to the workspace
   * default — so the legacy + federation path is unchanged.
   */
  private async resolveSendMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agent: { mailboxAccountId: string | null } | null,
  ) {
    if (agent?.mailboxAccountId) {
      const mb = await tx.mailboxAccount.findFirst({
        where: { id: agent.mailboxAccountId, workspaceId },
      });
      if (mb) return mb;
    }
    return this.defaultMailbox(tx);
  }

  /**
   * Append a row to the agent-mail action/audit log (the activity-feed source).
   * TRANSACTIONAL (not best-effort): it shares the caller's tx, so an event is
   * never recorded for an action that rolled back — and, conversely, an audit
   * INSERT failure rolls the action back (fail-closed; no un-audited action).
   * CAVEAT (compose mode=send): the external handToEngine() runs before this, so
   * a (negligible, single-row-insert) audit failure after a successful external
   * send would roll back the SoR row while the mail already left. Recording the
   * AUTONOMOUS_SEND intent before the engine hand-off is a possible hardening.
   */
  private async recordAction(
    tx: WorkspaceTxClient,
    workspaceId: string,
    data: {
      kind: AgentActionKind;
      agentKey?: string | null;
      messageId?: string | null;
      actorUcUid?: string | null;
      detail?: string | null;
    },
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

  // ── inbound engagement capture (Phase 2, Part A) ───────────────────────

  /**
   * Record an inbound engagement/delivery signal from the mail engine for a
   * message Email-Ops sent (Postmark today), idempotently + RLS-scoped.
   *
   * THE CRITICAL RLS PATTERN (brief): a provider webhook arrives
   * WORKSPACE-AGNOSTIC. We must NOT widen the RLS bypass to the mutation. So:
   *
   *   1. MINIMAL privileged resolve — a single owner-role / RLS-bypass lookup
   *      that resolves the provider `MessageID` → { id, workspaceId } ONLY. This
   *      is the smallest possible privileged surface: it reads exactly the id +
   *      the owning workspace, nothing else, and never writes. It runs on
   *      `this.prisma` (the base client = the owner connection) deliberately,
   *      because under the live NOBYPASSRLS runtime role a no-GUC read returns 0
   *      rows (fail-closed) and we'd never find the row to scope to.
   *
   *   2. SCOPED mutation — the actual event INSERT + the message status advance
   *      run INSIDE `withWorkspace(resolvedWorkspaceId, …)`, so RLS fences them
   *      to the resolved workspace and the table's WITH CHECK guarantees the row
   *      can only land there. The privileged step never touches a writable
   *      surface; the writable step is always RLS-scoped.
   *
   * IDEMPOTENT: the event is unique on (workspaceId, provider, providerEventId).
   * A re-delivery hits the unique index and is a clean no-op ('duplicate') — no
   * second row, no double/regressed status. The status advance is monotonic
   * (`shouldAdvanceStatus`) so an out-of-order record can't pull a later status
   * back down.
   *
   * UNMATCHED: a signal for a message we didn't send (no row owns the
   * providerMessageId) returns 'unmatched' — the webhook still ACKs 200 so the
   * provider stops retrying (it's not an error, just not ours).
   */
  async recordEngagementEvent(input: EngagementCaptureInput): Promise<EngagementCaptureResult> {
    // ── Step 1: MINIMAL privileged id→workspace resolve (read-only, id-only) ──
    // Resolve the most-recent message carrying this provider id. `select` is
    // restricted to exactly { id, workspaceId, status } — the id+workspace the
    // scoping needs, plus the current status for the monotonic-advance decision.
    // No body, no addressing, no contact — the bypass surface stays minimal.
    const owner = await this.prisma.emailMessage.findFirst({
      where: { providerMessageId: input.providerMessageId },
      select: { id: true, workspaceId: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!owner) {
      this.logger.warn(
        `engagement ${input.provider}/${input.recordType} for providerMessageId=${input.providerMessageId} (event ${input.providerEventId}) matched NO Email-Ops message — ACKing as unmatched (not ours)`,
      );
      return {
        outcome: 'unmatched',
        workspaceId: null,
        emailMessageId: null,
        normalizedKind: input.normalizedKind ? input.normalizedKind.toLowerCase() : null,
        statusBefore: null,
        statusAfter: null,
        statusAdvanced: false,
      };
    }

    // ── Step 2: the ACTUAL mutation, RLS-scoped to the resolved workspace ──
    return this.prisma.withWorkspace(owner.workspaceId, null, async (tx) => {
      // Idempotent insert: a re-delivery (same workspace+provider+eventId) is a
      // clean no-op. We pre-check then create; a concurrent racing insert is
      // caught by the unique-constraint guard below (P2002) and also treated as
      // a duplicate, so the path is safe under at-least-once webhook delivery.
      const already = await tx.emailEngagementEvent.findUnique({
        where: {
          workspaceId_provider_providerEventId: {
            workspaceId: owner.workspaceId,
            provider: input.provider,
            providerEventId: input.providerEventId,
          },
        },
        select: { id: true },
      });
      if (already) {
        this.logger.log(
          `engagement ${input.provider} event ${input.providerEventId} already captured for message ${owner.id} (workspace ${owner.workspaceId}) — idempotent no-op`,
        );
        return this.duplicateResult(owner.workspaceId, owner.id, input, owner.status);
      }

      try {
        await tx.emailEngagementEvent.create({
          data: {
            workspaceId: owner.workspaceId,
            emailMessageId: owner.id,
            provider: input.provider,
            providerEventId: input.providerEventId,
            recordType: input.recordType,
            normalizedKind: input.normalizedKind ?? undefined,
            occurredAt: input.occurredAt ?? new Date(),
            raw:
              input.raw === undefined || input.raw === null
                ? undefined
                : (input.raw as Prisma.InputJsonValue),
          },
        });
      } catch (err) {
        // A concurrent insert of the same provider event raced us — treat the
        // unique-violation as the idempotent no-op it is.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          this.logger.log(
            `engagement ${input.provider} event ${input.providerEventId} raced a concurrent capture for message ${owner.id} — idempotent no-op`,
          );
          return this.duplicateResult(owner.workspaceId, owner.id, input, owner.status);
        }
        throw err;
      }

      // Monotonic status advance: never regress a later status (the webhook is
      // the only non-regressing writer; see message-status.ts).
      const before = owner.status;
      const advance = shouldAdvanceStatus(before, input.statusTarget);
      let after = before;
      if (input.statusTarget && advance) {
        const updated = await tx.emailMessage.update({
          where: { id: owner.id },
          data: { status: input.statusTarget },
          select: { status: true },
        });
        after = updated.status;
        this.logger.log(
          `engagement ${input.provider}/${input.recordType} advanced message ${owner.id} status ${before} → ${after} (workspace ${owner.workspaceId})`,
        );
      } else if (input.statusTarget && !advance) {
        this.logger.log(
          `engagement ${input.provider}/${input.recordType} for message ${owner.id} implies ${input.statusTarget} but current ${before} is >= that rung — status held (non-regressing)`,
        );
      }

      return {
        outcome: 'recorded' as const,
        workspaceId: owner.workspaceId,
        emailMessageId: owner.id,
        normalizedKind: input.normalizedKind ? input.normalizedKind.toLowerCase() : null,
        statusBefore: before.toLowerCase(),
        statusAfter: after.toLowerCase(),
        statusAdvanced: after !== before,
      };
    });
  }

  /** Shared shape for an idempotent-duplicate engagement capture (no change). */
  private duplicateResult(
    workspaceId: string,
    emailMessageId: string,
    input: EngagementCaptureInput,
    currentStatus: EmailMessageStatus,
  ): EngagementCaptureResult {
    return {
      outcome: 'duplicate',
      workspaceId,
      emailMessageId,
      normalizedKind: input.normalizedKind ? input.normalizedKind.toLowerCase() : null,
      statusBefore: currentStatus.toLowerCase(),
      statusAfter: currentStatus.toLowerCase(),
      statusAdvanced: false,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Hand a recorded outbound message to the mail engine and persist the result
   * status. Degrade-clean: an unconfigured/failed engine marks the row FAILED
   * (the SoR row + agent-inbox state are already durable) rather than throwing.
   */
  private async handToEngine(
    tx: WorkspaceTxClient,
    messageId: string,
    req: {
      fromAddress: string;
      fromName: string | null;
      toAddress: string;
      subject: string;
      body: string;
      inReplyToThreadId: string | null;
      transactional: boolean;
    },
  ) {
    const result = await this.stalwart.send(
      req.fromAddress,
      {
        fromAddress: req.fromAddress,
        fromName: req.fromName,
        toAddress: req.toAddress,
        subject: req.subject,
        body: req.body,
        inReplyToThreadId: req.inReplyToThreadId,
      },
      req.transactional,
    );
    const status = result.accepted ? EmailMessageStatus.SENT : EmailMessageStatus.FAILED;
    if (!result.accepted) {
      this.logger.warn(
        `message ${messageId} send NOT accepted by mail engine (lane=${result.lane ?? 'none'}): ${result.reason ?? 'unknown'} — recorded FAILED (degrade-clean)`,
      );
    }
    return tx.emailMessage.update({
      where: { id: messageId },
      data: {
        status,
        providerMessageId: result.providerMessageId,
        threadId: result.threadId ?? undefined,
        sentAt: result.accepted ? new Date() : null,
      },
    });
  }

  /** The workspace's default mailbox account (RLS-scoped), or null. */
  private async defaultMailbox(tx: WorkspaceTxClient) {
    const def = await tx.mailboxAccount.findFirst({
      where: { isDefault: true, active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (def) return def;
    return tx.mailboxAccount.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } });
  }

  private async resolveUserByUcUid(tx: WorkspaceTxClient, ucUid: string | null) {
    if (!ucUid) return null;
    return tx.user.findFirst({
      where: {
        OR: [{ keycloakId: ucUid }, { id: ucUid }],
      },
    });
  }

  /**
   * Resolve a contact's deliverable address. Contact-Ops is the canonical
   * phonebook (federated), but Email-Ops doesn't store contacts; for the read
   * path we use the most recent outbound `toAddress` we recorded for this
   * contact as the address hint (a brand-new contact with no history yields null
   * and the live-thread lookup is skipped — degrade-clean).
   */
  private async contactAddress(tx: WorkspaceTxClient, contactId: string): Promise<string | null> {
    const last = await tx.emailMessage.findFirst({
      where: { contactId, toAddress: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { toAddress: true },
    });
    return last?.toAddress ?? null;
  }

  private composeView(m: {
    id: string;
    threadId: string | null;
    status: EmailMessageStatus;
    mode: EmailMode;
    externalSource: string | null;
    externalRef: string | null;
    createdAt: Date;
  }): MessageComposeView {
    return {
      id: m.id,
      thread_id: m.threadId ?? null,
      status: this.statusWire(m.status),
      mode: this.modeWire(m.mode),
      external_source: m.externalSource ?? null,
      external_ref: m.externalRef ?? null,
      created_at: m.createdAt ? m.createdAt.toISOString() : null,
    };
  }

  private inboxView(
    it: {
      id: string;
      messageId: string | null;
      kind?: AgentInboxKind;
      payload?: unknown;
      state: AgentInboxState;
      draftedBy: string | null;
      summary: string | null;
      reviewedByUcUid: string | null;
      reviewedAt: Date | null;
      reviewNote: string | null;
      createdAt: Date;
    },
    msg: {
      toAddress: string | null;
      subject: string | null;
      body?: string | null;
      preview?: string | null;
    } | null,
  ): AgentInboxView {
    const payload = this.cleanupPayload(it.payload);
    const isCleanup = it.kind === AgentInboxKind.CLEANUP;
    return {
      id: it.id,
      message_id: it.messageId,
      kind: it.kind ?? 'EMAIL',
      state: it.state.toLowerCase(),
      drafted_by: it.draftedBy ?? null,
      summary: it.summary ?? (isCleanup ? this.cleanupSummary(payload) : null),
      to_address: isCleanup ? null : msg?.toAddress ?? null,
      subject: isCleanup ? this.cleanupSubject(payload) : msg?.subject ?? null,
      body_preview: isCleanup
        ? this.cleanupBodyPreview(payload)
        : msg
          ? msg.preview ?? this.snippet(msg.body)
          : null,
      reviewed_by_uc_uid: it.reviewedByUcUid ?? null,
      reviewed_at: it.reviewedAt ? it.reviewedAt.toISOString() : null,
      review_note: it.reviewNote ?? null,
      created_at: it.createdAt ? it.createdAt.toISOString() : null,
      payload: isCleanup ? payload : null,
    };
  }

  private snippet(body: string | null | undefined): string | null {
    if (!body) return null;
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
  }

  private summary(subject: string | null | undefined, to: string | null | undefined): string {
    const s = subject?.trim() || '(no subject)';
    return to ? `${s} → ${to}` : s;
  }

  private cleanupPayload(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private cleanupSummary(payload: Record<string, unknown>): string | null {
    const action = typeof payload.action === 'string' ? payload.action : 'cleanup';
    const provider = typeof payload.provider === 'string' ? payload.provider : '';
    const count = Array.isArray((payload.plan as Record<string, unknown> | undefined)?.safe)
      ? ((payload.plan as Record<string, unknown>).safe as unknown[]).length
      : 0;
    return `${action}${provider ? ` on ${provider}` : ''}${count ? ` (${count} safe)` : ''}`;
  }

  private cleanupSubject(payload: Record<string, unknown>): string | null {
    const action = typeof payload.action === 'string' ? payload.action : 'Cleanup';
    return `${action[0]?.toUpperCase() ?? 'C'}${action.slice(1)} request`;
  }

  private cleanupBodyPreview(payload: Record<string, unknown>): string | null {
    const plan = payload.plan && typeof payload.plan === 'object' ? (payload.plan as Record<string, unknown>) : null;
    const safe = Array.isArray(plan?.safe) ? (plan?.safe as Array<Record<string, unknown>>) : [];
    const protectedCount = Array.isArray(plan?.protected) ? (plan?.protected as unknown[]).length : 0;
    return `${safe.length} safe · ${protectedCount} protected`;
  }

  /** Surfaced for a future REST seam / tests that want a Prisma type alias. */
  static readonly _txType: Prisma.TransactionClient | undefined = undefined;
}
