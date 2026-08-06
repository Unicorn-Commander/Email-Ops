import { Injectable, Logger } from '@nestjs/common';
import {
  MailboxAccount,
  Prisma,
  ScheduledSend,
  ScheduledSendState,
  SnoozedThread,
  SnoozedThreadState,
} from '@prisma/client';
import { EmailService } from '../email/email.service';
import { ComposeInput } from '../email/email.types';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { ucUidOf } from '../common/workspace/workspace.util';
import {
  ScheduledSendPayload,
  ScheduledSendView,
  SchedulingUser,
  SnoozedThreadView,
  SnoozeThreadInput,
} from './scheduling.types';

const SCHEDULER_SOURCE = 'email-ops-client';

@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);
  // A claim older than this is treated as abandoned (worker died mid-send) and
  // is reclaimed on the next sweep. Well above the multi-second send window so a
  // legitimately in-flight send is never reaped; the 30s worker retries after.
  private static readonly CLAIM_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
    private readonly mailProvider: MailProviderPort,
    private readonly email: EmailService,
  ) {}

  async snoozeThread(
    user: SchedulingUser,
    input: SnoozeThreadInput,
  ): Promise<{ snoozed: boolean; item: SnoozedThreadView | null }> {
    const ucUid = ucUidOf(user);
    // Reject an invalid `until` BEFORE the (committed, external) archive move, so a
    // bad time never strands the thread out of Inbox with no SnoozedThread row.
    // REST validates via @IsISO8601; this covers the MCP + any other caller.
    if (!Number.isFinite(input.until.getTime())) return { snoozed: false, item: null };
    const mailbox = await this.resolveSovereignMailboxForCaller(input.workspaceId, ucUid, input.mailboxId);
    if (!mailbox || !this.stalwart.isConfigured()) return { snoozed: false, item: null };

    // Capture the subject for the Snoozed view BEFORE the archive move (the thread
    // is still in Inbox and definitely locatable). Best-effort + degrade-clean.
    const subject = await this.resolveSnoozeSubject(input, mailbox.emailAddress);

    const hidden = await this.stalwart.moveThreadToFolder(mailbox.emailAddress, input.threadId, 'archive');
    if (!hidden) return { snoozed: false, item: null };

    const row = await this.prisma.withWorkspace(input.workspaceId, ucUid, async (tx) =>
      tx.snoozedThread.create({
        data: {
          workspaceId: input.workspaceId,
          mailboxId: input.mailboxId,
          threadId: input.threadId,
          snoozeUntil: input.until,
          subject,
          createdBy: ucUid || null,
        },
      }),
    );
    return { snoozed: true, item: this.snoozedView(row) };
  }

  async unsnooze(
    user: SchedulingUser,
    workspaceId: string,
    id: string,
  ): Promise<{ unsnoozed: boolean }> {
    const ucUid = ucUidOf(user);
    const row = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.snoozedThread.findFirst({ where: { id, workspaceId, state: SnoozedThreadState.ACTIVE } }),
    );
    if (!row) return { unsnoozed: false };

    const mailbox = await this.resolveSovereignMailboxForCaller(workspaceId, ucUid, row.mailboxId);
    if (!mailbox || !this.stalwart.isConfigured()) return { unsnoozed: false };

    const restored = await this.stalwart.moveThreadToFolder(mailbox.emailAddress, row.threadId, 'inbox');
    if (!restored) return { unsnoozed: false };

    await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.snoozedThread.update({
        where: { id },
        data: { state: SnoozedThreadState.CANCELLED },
      }),
    );
    return { unsnoozed: true };
  }

  async unsnoozeThread(
    user: SchedulingUser,
    input: { workspaceId: string; mailboxId: string; threadId: string },
  ): Promise<{ unsnoozed: boolean }> {
    const ucUid = ucUidOf(user);
    const row = await this.prisma.withWorkspace(input.workspaceId, ucUid, (tx) =>
      tx.snoozedThread.findFirst({
        where: {
          workspaceId: input.workspaceId,
          mailboxId: input.mailboxId,
          threadId: input.threadId,
          state: SnoozedThreadState.ACTIVE,
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (!row) return { unsnoozed: false };
    return this.unsnooze(user, input.workspaceId, row.id);
  }

  async listSnoozed(
    user: SchedulingUser,
    workspaceId: string,
    mailboxId: string,
  ): Promise<SnoozedThreadView[]> {
    const ucUid = ucUidOf(user);
    const mailbox = await this.resolveSovereignMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || !this.stalwart.isConfigured()) return [];
    const rows = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.snoozedThread.findMany({
        where: { workspaceId, mailboxId, state: SnoozedThreadState.ACTIVE },
        orderBy: { snoozeUntil: 'asc' },
      }),
    );
    return rows.map((row) => this.snoozedView(row));
  }

  async scheduleSend(
    user: SchedulingUser,
    input: {
      workspaceId: string;
      mailboxId: string;
      payload: ScheduledSendPayload;
      sendAt: Date;
    },
  ): Promise<{ scheduled: boolean; item: ScheduledSendView | null }> {
    const ucUid = ucUidOf(user);
    // Reject an invalid sendAt before any write (REST validates via @IsISO8601;
    // this covers the MCP + any other caller so a bad time can't crash the write).
    if (!Number.isFinite(input.sendAt.getTime())) return { scheduled: false, item: null };
    const mailbox = await this.resolveSovereignMailboxForCaller(input.workspaceId, ucUid, input.mailboxId);
    if (!mailbox || !this.stalwart.isConfigured()) return { scheduled: false, item: null };

    const payload = this.normalizePayload(input.payload);
    if (!payload) return { scheduled: false, item: null };

    const row = await this.prisma.withWorkspace(input.workspaceId, ucUid, (tx) =>
      tx.scheduledSend.create({
        data: {
          workspaceId: input.workspaceId,
          mailboxId: input.mailboxId,
          payload: payload as unknown as Prisma.InputJsonValue,
          sendAt: input.sendAt,
          createdBy: ucUid || null,
        },
      }),
    );
    return { scheduled: true, item: this.scheduledView(row) };
  }

  async cancelScheduledSend(
    user: SchedulingUser,
    workspaceId: string,
    id: string,
  ): Promise<{ cancelled: boolean }> {
    const ucUid = ucUidOf(user);
    const row = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.scheduledSend.findFirst({ where: { id, workspaceId, state: ScheduledSendState.PENDING } }),
    );
    if (!row) return { cancelled: false };
    // Same sovereign-owner gate as unsnooze: a workspace member must be able to
    // act through the owning mailbox to cancel its pending send.
    const mailbox = await this.resolveSovereignMailboxForCaller(workspaceId, ucUid, row.mailboxId);
    if (!mailbox) return { cancelled: false };

    const updated = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.scheduledSend.updateMany({
        where: { id, workspaceId, state: ScheduledSendState.PENDING },
        data: { state: ScheduledSendState.CANCELLED },
      }),
    );
    return { cancelled: updated.count === 1 };
  }

  async listScheduledSends(
    user: SchedulingUser,
    workspaceId: string,
    mailboxId: string,
  ): Promise<ScheduledSendView[]> {
    const ucUid = ucUidOf(user);
    const mailbox = await this.resolveSovereignMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || !this.stalwart.isConfigured()) return [];
    const rows = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.scheduledSend.findMany({
        where: { workspaceId, mailboxId, state: { in: [ScheduledSendState.PENDING, ScheduledSendState.CLAIMED] } },
        orderBy: { sendAt: 'asc' },
      }),
    );
    return rows.map((row) => this.scheduledView(row));
  }

  /** Fetch ONE scheduled send in ANY state (the list hides terminal rows). The
   *  undo-send bar polls this after its window closes for a truthful SENT/FAILED
   *  verdict instead of guessing from absence. Null = missing/foreign/dormant. */
  async getScheduledSend(
    user: SchedulingUser,
    workspaceId: string,
    mailboxId: string,
    id: string,
  ): Promise<ScheduledSendView | null> {
    const ucUid = ucUidOf(user);
    const mailbox = await this.resolveSovereignMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || !this.stalwart.isConfigured()) return null;
    const row = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      // Scoped by workspaceId AND mailboxId: a foreign id resolves to null, never
      // to another tenant's payload (same explicit fence as the list).
      tx.scheduledSend.findFirst({ where: { id, workspaceId, mailboxId } }),
    );
    return row ? this.scheduledView(row) : null;
  }

  async surfaceDueSnoozes(now = new Date(), take = 100): Promise<number> {
    const rows = await this.prisma.systemClient.snoozedThread.findMany({
      where: {
        state: SnoozedThreadState.ACTIVE,
        snoozeUntil: { lte: now },
      },
      take,
      orderBy: { snoozeUntil: 'asc' },
    });

    let surfaced = 0;
    for (const row of rows) {
      try {
        const mailbox = await this.prisma.systemClient.mailboxAccount.findFirst({
          where: { id: row.mailboxId, workspaceId: row.workspaceId, provider: 'stalwart', active: true },
          select: { emailAddress: true },
        });
        if (!mailbox || !this.stalwart.isConfigured()) continue;
        const restored = await this.stalwart.moveThreadToFolder(mailbox.emailAddress, row.threadId, 'inbox');
        if (!restored) continue;

        const claimed = await this.prisma.systemClient.snoozedThread.updateMany({
          where: { id: row.id, state: SnoozedThreadState.ACTIVE },
          data: { state: SnoozedThreadState.SURFACED },
        });
        if (claimed.count !== 1) continue;
        surfaced += 1;
      } catch (err) {
        this.logger.warn(`snooze wake failed row=${row.id}: ${(err as Error).message}`);
      }
    }
    return surfaced;
  }

  async fireDueScheduledSends(now = new Date(), take = 50): Promise<number> {
    // A CLAIMED row whose claim is older than the TTL means the worker died
    // between claim and terminal transition — reclaim and retry it. composeEmail
    // is idempotent on externalRef (scheduled-send:<id>), so a half-finished send
    // is deduped, never doubled; without this the row would be stranded forever.
    const staleClaimBefore = new Date(now.getTime() - SchedulingService.CLAIM_TTL_MS);
    const rows = await this.prisma.systemClient.scheduledSend.findMany({
      where: {
        OR: [
          { state: ScheduledSendState.PENDING, sendAt: { lte: now } },
          { state: ScheduledSendState.CLAIMED, claimedAt: { lte: staleClaimBefore } },
        ],
      },
      take,
      orderBy: { sendAt: 'asc' },
    });

    let sent = 0;
    for (const row of rows) {
      try {
        // Claim (PENDING) or reclaim (stale CLAIMED) atomically — guard on the
        // exact state+claimedAt we read so only one worker wins the race.
        const claimed = await this.prisma.systemClient.scheduledSend.updateMany({
          where:
            row.state === ScheduledSendState.CLAIMED
              ? { id: row.id, state: ScheduledSendState.CLAIMED, claimedAt: row.claimedAt }
              : { id: row.id, state: ScheduledSendState.PENDING },
          data: { state: ScheduledSendState.CLAIMED, claimedAt: now },
        });
        if (claimed.count !== 1) continue;

        const payload = this.normalizePayload(row.payload);
        if (!payload) {
          await this.markScheduledSend(row, ScheduledSendState.FAILED);
          continue;
        }
        const mailbox = await this.prisma.systemClient.mailboxAccount.findFirst({
          where: { id: row.mailboxId, workspaceId: row.workspaceId, provider: 'stalwart', active: true },
          select: { id: true },
        });
        if (!mailbox || !this.stalwart.isConfigured()) {
          await this.markScheduledSend(row, ScheduledSendState.FAILED);
          continue;
        }

        const result = await this.email.composeEmail(row.workspaceId, row.createdBy, this.composeInput(row, payload));
        if (result.status === 'failed') {
          await this.markScheduledSend(row, ScheduledSendState.FAILED);
          continue;
        }
        await this.markScheduledSend(row, ScheduledSendState.SENT, new Date());
        sent += 1;
      } catch (err) {
        this.logger.warn(`scheduled send failed row=${row.id}: ${(err as Error).message}`);
        await this.markScheduledSend(row, ScheduledSendState.FAILED).catch(() => undefined);
      }
    }
    return sent;
  }

  private async markScheduledSend(
    row: Pick<ScheduledSend, 'id'>,
    state: ScheduledSendState,
    sentAt: Date | null = null,
  ): Promise<void> {
    await this.prisma.systemClient.scheduledSend.updateMany({
      where: { id: row.id, state: ScheduledSendState.CLAIMED },
      data: { state, sentAt },
    });
  }

  private composeInput(row: ScheduledSend, payload: ScheduledSendPayload): ComposeInput {
    return {
      contactId: null,
      toAddress: payload.toAddress,
      toAddresses: payload.toAddresses,
      subject: payload.subject,
      body: payload.body,
      bodyHtml: payload.bodyHtml ?? null,
      mode: 'send',
      inReplyToThreadId: payload.inReplyToThreadId ?? null,
      externalSource: SCHEDULER_SOURCE,
      externalRef: `scheduled-send:${row.id}`,
      draftedBy: null,
      fromMailboxAccountId: row.mailboxId,
      cc: payload.cc,
      bcc: payload.bcc,
      attachments: payload.attachments,
      inReplyToMessageId: payload.inReplyToMessageId ?? null,
      references: payload.references,
      draftId: payload.draftId ?? null,
    };
  }

  private async resolveSovereignMailboxForCaller(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<MailboxAccount | null> {
    const mailbox = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const found = await tx.mailboxAccount.findFirst({
        where: { id: mailboxId, workspaceId, active: true },
      });
      if (!found) return null;
      if (!(await this.mayActThroughMailbox(tx, found, ucUid))) return null;
      return found;
    });
    if (!mailbox || this.mailProvider.handles(mailbox)) return null;
    return mailbox;
  }

  private async mayActThroughMailbox(
    tx: WorkspaceTxClient,
    mailbox: { ownerKind: string; ownerKey: string | null },
    ucUid: string | null,
  ): Promise<boolean> {
    if (mailbox.ownerKind !== 'HUMAN') return true;
    if (!mailbox.ownerKey || !ucUid) return false;
    if (mailbox.ownerKey === ucUid) return true;
    const u = await tx.user.findFirst({
      where: { OR: [{ keycloakId: ucUid }, { id: ucUid }] },
    });
    return !!u && (mailbox.ownerKey === u.keycloakId || mailbox.ownerKey === u.id);
  }

  private normalizePayload(raw: unknown): ScheduledSendPayload | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    const toAddress = typeof obj.toAddress === 'string' ? obj.toAddress.trim() : '';
    if (!toAddress) return null;
    return {
      toAddress,
      toAddresses: this.stringArray(obj.toAddresses),
      subject: typeof obj.subject === 'string' ? obj.subject : '',
      body: typeof obj.body === 'string' ? obj.body : '',
      bodyHtml: typeof obj.bodyHtml === 'string' ? obj.bodyHtml : null,
      cc: this.stringArray(obj.cc),
      bcc: this.stringArray(obj.bcc),
      attachments: this.attachments(obj.attachments),
      inReplyToThreadId: typeof obj.inReplyToThreadId === 'string' ? obj.inReplyToThreadId : null,
      inReplyToMessageId: typeof obj.inReplyToMessageId === 'string' ? obj.inReplyToMessageId : null,
      references: this.stringArray(obj.references),
      draftId: typeof obj.draftId === 'string' ? obj.draftId : null,
    };
  }

  private stringArray(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return out.length ? out : undefined;
  }

  private attachments(raw: unknown): { blob_id: string; name: string; type: string }[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out = raw
      .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
      .map((a) => ({
        blob_id: typeof a.blob_id === 'string' ? a.blob_id : '',
        name: typeof a.name === 'string' && a.name.trim() ? a.name : 'attachment',
        type: typeof a.type === 'string' && a.type.trim() ? a.type : 'application/octet-stream',
      }))
      .filter((a) => a.blob_id);
    return out.length ? out : undefined;
  }

  /**
   * The subject stored on a new snooze row. Prefer the caller-supplied subject
   * (the webmail reader has it), else resolve it best-effort from the engine so
   * an agent-initiated snooze (no subject in hand) still renders a human row.
   * Degrade-clean: returns null when the engine is dormant/unknown/fails — the
   * Snoozed view falls back to a neutral label. Never throws.
   */
  private async resolveSnoozeSubject(
    input: SnoozeThreadInput,
    mailboxAddress: string,
  ): Promise<string | null> {
    const provided = (input.subject ?? '').trim();
    if (provided) return provided.slice(0, 300);
    try {
      const detail = await this.stalwart.getThreadDetail(mailboxAddress, input.threadId);
      // The most recent non-empty subject (matches what the reader shows).
      for (let i = detail.length - 1; i >= 0; i--) {
        const s = detail[i].subject?.trim();
        if (s) return s.slice(0, 300);
      }
      return null;
    } catch {
      return null;
    }
  }

  private snoozedView(row: SnoozedThread): SnoozedThreadView {
    return {
      id: row.id,
      mailbox_id: row.mailboxId,
      thread_id: row.threadId,
      subject: row.subject ?? null,
      snooze_until: row.snoozeUntil.toISOString(),
      state: row.state.toLowerCase(),
      created_by: row.createdBy,
      created_at: row.createdAt.toISOString(),
    };
  }

  private scheduledView(row: ScheduledSend): ScheduledSendView {
    return {
      id: row.id,
      mailbox_id: row.mailboxId,
      payload: this.normalizePayload(row.payload) ?? {
        toAddress: '',
        subject: '',
        body: '',
      },
      send_at: row.sendAt.toISOString(),
      state: row.state.toLowerCase(),
      created_by: row.createdBy,
      created_at: row.createdAt.toISOString(),
      sent_at: row.sentAt?.toISOString() ?? null,
    };
  }
}
