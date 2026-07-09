import { EmailMessageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import {
  StalwartBlobDownload,
  StalwartDraftRequest,
  StalwartFolderQuery,
  StalwartFolderThreadsResult,
  StalwartMailboxCounts,
  StalwartMessage,
  StalwartMessageDetail,
  StalwartMessageHeaders,
  StalwartSendRequest,
  StalwartSendResult,
  StalwartVacationState,
  StalwartThread,
  StalwartUploadResult,
} from '../stalwart/stalwart.types';
import { EmailService } from '../email/email.service';
import { mapPostmarkRecord, PostmarkWebhookBody } from './postmark.types';

/**
 * Engagement-capture integration tests (against the REAL verify DB; Stalwart
 * MOCKED). These prove the brief's Part-A contract end-to-end through
 * EmailService.recordEngagementEvent — the SAME path the webhook controller
 * calls — plus the critical RLS-scoping property:
 *
 *   - each Postmark record type → the right status/engagement persisted,
 *   - idempotent re-delivery: a repeat event is a no-op (no duplicate row, no
 *     double/regressed status),
 *   - the privileged-resolve-then-withWorkspace write lands the row in the
 *     OWNING message's workspace (and ONLY there) — cross-workspace isolation,
 *   - monotonic status: an out-of-order/older record never regresses the status,
 *   - an unmatched provider id is a clean no-op (nothing persisted).
 *
 * The verify DB is the same po-verify-pg the task provisions
 * (postgresql://postgres:REMOVED@127.0.0.1:55444/emailops). Tests connect as the
 * superuser owner (RLS inert under FORCE+BYPASS for owner) = the Phase-1 runtime
 * posture; the SEPARATE prisma/rls-acceptance.sql proves the fence under the
 * NOBYPASSRLS email_ops_app role (incl. the new email_engagement_events table).
 */

const DB_URL = 'postgresql://postgres:REMOVED@127.0.0.1:55444/emailops?schema=public';

class FakeStalwart extends StalwartPort {
  public acceptSend = true;
  isConfigured(): boolean {
    return true;
  }
  async listThreads(): Promise<StalwartThread[]> {
    return [];
  }
  async listMessages(): Promise<StalwartMessage[]> {
    return [];
  }
  async listFolderThreads(
    _mailbox: string,
    _query: StalwartFolderQuery,
  ): Promise<StalwartFolderThreadsResult> {
    return { threads: [] };
  }
  async getThreadDetail(): Promise<StalwartMessageDetail[]> {
    return [];
  }
  async setThreadRead(): Promise<boolean> {
    return true;
  }
  async moveThreadToFolder(): Promise<boolean> {
    return true;
  }
  async getMailboxCounts(): Promise<StalwartMailboxCounts | null> {
    return null;
  }
  async downloadBlob(): Promise<StalwartBlobDownload | null> {
    return null;
  }
  async saveDraft(_mailbox: string, _draft: StalwartDraftRequest): Promise<{ id: string } | null> {
    return null;
  }
  async updateDraft(
    _mailbox: string,
    _draftId: string,
    _draft: StalwartDraftRequest,
  ): Promise<{ id: string } | null> {
    return null;
  }
  async deleteDraft(): Promise<boolean> {
    return false;
  }
  async getVacation(): Promise<StalwartVacationState | null> {
    return null;
  }
  async setVacation(): Promise<boolean> {
    return false;
  }
  async getMessageHeaders(): Promise<StalwartMessageHeaders | null> {
    return null;
  }
  async uploadBlob(): Promise<StalwartUploadResult | null> {
    return null;
  }
  async send(
    _mailbox: string,
    req: StalwartSendRequest,
    transactional: boolean,
  ): Promise<StalwartSendResult> {
    if (!this.acceptSend) {
      return { accepted: false, providerMessageId: null, threadId: null, lane: 'stalwart', reason: 'rejected' };
    }
    // Echo a deterministic provider id so the webhook can resolve back to the row.
    return {
      accepted: true,
      providerMessageId: req.subject.includes('::pmid=')
        ? req.subject.split('::pmid=')[1]
        : `prov-${Math.random().toString(16).slice(2)}`,
      threadId: req.inReplyToThreadId ?? `thread-${Math.random().toString(16).slice(2)}`,
      lane: transactional ? 'postmark' : 'stalwart',
    };
  }
}

describe('Engagement capture (verify DB; Stalwart MOCKED)', () => {
  let prisma: PrismaService;
  let stalwart: FakeStalwart;
  let service: EmailService;

  const WS_A = `0190a000-7e57-7000-8000-0000${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
  const WS_B = `0190a000-7e57-7000-8000-0000${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
  const UC_UID = 'uc-uid-eng-test';

  // Seed a SENT message in a workspace with a known providerMessageId, returning
  // its row id. We write the providerMessageId directly (the SoR row + the
  // provider id) so the webhook has a target to resolve.
  async function seedSentMessage(ws: string, providerMessageId: string, ref: string) {
    return prisma.withWorkspace(ws, UC_UID, async (tx) =>
      tx.emailMessage.create({
        data: {
          workspaceId: ws,
          contactId: 'contact-eng',
          threadId: `thread-${ref}`,
          externalSource: 'customer-ops',
          externalRef: ref,
          mode: 'SEND',
          status: EmailMessageStatus.SENT,
          direction: 'SENT',
          toAddress: 'lead@acme.test',
          subject: 'Engagement target',
          providerMessageId,
        },
        select: { id: true },
      }),
    );
  }

  // Build the capture input the webhook would hand the service for a Postmark body.
  function capture(body: PostmarkWebhookBody) {
    const m = mapPostmarkRecord(body)!;
    return {
      provider: 'postmark',
      providerMessageId: m.providerMessageId!,
      providerEventId: m.providerEventId,
      recordType: m.recordType,
      normalizedKind: m.normalizedKind,
      statusTarget: m.statusTarget,
      occurredAt: m.occurredAt,
      raw: body,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const ws of [WS_A, WS_B]) {
      await prisma.workspace.upsert({
        where: { id: ws },
        update: {},
        create: { id: ws, slug: `ws-${ws.slice(-6)}`, displayName: 'Engagement test ws' },
      });
    }
    stalwart = new FakeStalwart();
    service = new EmailService(
      prisma,
      stalwart,
      {
        approveCleanupBatch: jest.fn(),
        undoBatch: jest.fn(),
      } as any,
      {
        handles: () => false,
        listInbox: async () => [],
        listThreadMessages: async () => [],
        send: async () => ({ accepted: false, providerMessageId: null, threadId: null, reason: 'test' }),
      } as any,
    );
  });

  afterAll(async () => {
    if (prisma) {
      for (const ws of [WS_A, WS_B]) {
        await prisma.emailEngagementEvent.deleteMany({ where: { workspaceId: ws } });
        await prisma.agentInboxItem.deleteMany({ where: { workspaceId: ws } });
        await prisma.emailMessage.deleteMany({ where: { workspaceId: ws } });
        await prisma.workspace.deleteMany({ where: { id: ws } });
      }
      await prisma.$disconnect();
    }
  });

  it('Delivery advances a SENT message → DELIVERED + records an engagement event (no normalizedKind)', async () => {
    const pmid = `pmid-deliv-${Date.now()}`;
    const msg = await seedSentMessage(WS_A, pmid, `deliv-${Date.now()}`);
    const res = await service.recordEngagementEvent(
      capture({ RecordType: 'Delivery', MessageID: pmid, DeliveredAt: '2026-06-03T10:00:00Z' }),
    );
    expect(res.outcome).toBe('recorded');
    expect(res.workspaceId).toBe(WS_A);
    expect(res.emailMessageId).toBe(msg.id);
    expect(res.statusAdvanced).toBe(true);
    expect(res.statusAfter).toBe('delivered');
    expect(res.normalizedKind).toBeNull();

    const row = await prisma.emailMessage.findUnique({ where: { id: msg.id } });
    expect(row?.status).toBe('DELIVERED');
    const events = await prisma.emailEngagementEvent.findMany({ where: { emailMessageId: msg.id } });
    expect(events).toHaveLength(1);
    expect(events[0].recordType).toBe('Delivery');
    expect(events[0].normalizedKind).toBeNull();
    expect(events[0].workspaceId).toBe(WS_A); // the write landed in the OWNING workspace.
  });

  it('Open records an OPENED engagement event WITHOUT changing the status', async () => {
    const pmid = `pmid-open-${Date.now()}`;
    const msg = await seedSentMessage(WS_A, pmid, `open-${Date.now()}`);
    const res = await service.recordEngagementEvent(
      capture({ RecordType: 'Open', MessageID: pmid, ReceivedAt: '2026-06-03T11:00:00Z' }),
    );
    expect(res.outcome).toBe('recorded');
    expect(res.normalizedKind).toBe('opened');
    expect(res.statusAdvanced).toBe(false);
    const row = await prisma.emailMessage.findUnique({ where: { id: msg.id } });
    expect(row?.status).toBe('SENT'); // unchanged — Open is engagement-only.
  });

  it('Bounce advances → BOUNCED and records a bounced engagement event', async () => {
    const pmid = `pmid-bounce-${Date.now()}`;
    const msg = await seedSentMessage(WS_A, pmid, `bounce-${Date.now()}`);
    const res = await service.recordEngagementEvent(
      capture({ RecordType: 'Bounce', MessageID: pmid, ID: 555001, Type: 'HardBounce', BouncedAt: '2026-06-03T12:00:00Z' }),
    );
    expect(res.outcome).toBe('recorded');
    expect(res.normalizedKind).toBe('bounced');
    expect(res.statusAfter).toBe('bounced');
    const row = await prisma.emailMessage.findUnique({ where: { id: msg.id } });
    expect(row?.status).toBe('BOUNCED');
  });

  it('SpamComplaint + SubscriptionChange both record an unsubscribed engagement (status held)', async () => {
    const pmid = `pmid-unsub-${Date.now()}`;
    const msg = await seedSentMessage(WS_A, pmid, `unsub-${Date.now()}`);
    const spam = await service.recordEngagementEvent(
      capture({ RecordType: 'SpamComplaint', MessageID: pmid, ID: 555002, BouncedAt: '2026-06-03T12:30:00Z' }),
    );
    expect(spam.normalizedKind).toBe('unsubscribed');
    expect(spam.statusAdvanced).toBe(false);
    const sub = await service.recordEngagementEvent(
      capture({ RecordType: 'SubscriptionChange', MessageID: pmid, SuppressSending: true, ChangedAt: '2026-06-03T13:00:00Z' }),
    );
    expect(sub.normalizedKind).toBe('unsubscribed');

    const events = await prisma.emailEngagementEvent.findMany({
      where: { emailMessageId: msg.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.normalizedKind)).toEqual(['UNSUBSCRIBED', 'UNSUBSCRIBED']);
    const row = await prisma.emailMessage.findUnique({ where: { id: msg.id } });
    expect(row?.status).toBe('SENT'); // an unsubscribe is engagement; delivery status holds.
  });

  it('is IDEMPOTENT: a re-delivered event is a no-op (no duplicate row, no double status advance)', async () => {
    const pmid = `pmid-idem-${Date.now()}`;
    const msg = await seedSentMessage(WS_A, pmid, `idem-${Date.now()}`);
    const body: PostmarkWebhookBody = { RecordType: 'Bounce', MessageID: pmid, ID: 555003, BouncedAt: '2026-06-03T12:00:00Z' };

    const first = await service.recordEngagementEvent(capture(body));
    const second = await service.recordEngagementEvent(capture(body)); // exact re-delivery.
    expect(first.outcome).toBe('recorded');
    expect(second.outcome).toBe('duplicate');
    expect(second.statusAdvanced).toBe(false);

    // Exactly ONE event row for the (workspace, provider, providerEventId).
    const events = await prisma.emailEngagementEvent.findMany({ where: { emailMessageId: msg.id } });
    expect(events).toHaveLength(1);
    const row = await prisma.emailMessage.findUnique({ where: { id: msg.id } });
    expect(row?.status).toBe('BOUNCED');
  });

  it('is MONOTONIC: a late Delivery after DELIVERED does not regress; an Open never lowers DELIVERED', async () => {
    const pmid = `pmid-mono-${Date.now()}`;
    const msg = await seedSentMessage(WS_A, pmid, `mono-${Date.now()}`);
    // First deliver.
    await service.recordEngagementEvent(
      capture({ RecordType: 'Delivery', MessageID: pmid, DeliveredAt: '2026-06-03T10:00:00Z' }),
    );
    // An Open arrives later — engagement only; must NOT pull DELIVERED back to SENT.
    const open = await service.recordEngagementEvent(
      capture({ RecordType: 'Open', MessageID: pmid, ReceivedAt: '2026-06-03T10:05:00Z' }),
    );
    expect(open.statusAdvanced).toBe(false);
    const row = await prisma.emailMessage.findUnique({ where: { id: msg.id } });
    expect(row?.status).toBe('DELIVERED');
  });

  it('RLS-SCOPING: the privileged resolve + withWorkspace write lands the event in the OWNING workspace only', async () => {
    // Same logical provider id pattern, but two DIFFERENT messages in two
    // DIFFERENT workspaces. A Delivery for B's id must touch ONLY B's row + B's
    // workspace — never A — proving the resolve→withWorkspace scoping.
    const pmidA = `pmid-scopeA-${Date.now()}`;
    const pmidB = `pmid-scopeB-${Date.now()}`;
    const msgA = await seedSentMessage(WS_A, pmidA, `scopeA-${Date.now()}`);
    const msgB = await seedSentMessage(WS_B, pmidB, `scopeB-${Date.now()}`);

    const resB = await service.recordEngagementEvent(
      capture({ RecordType: 'Delivery', MessageID: pmidB, DeliveredAt: '2026-06-03T14:00:00Z' }),
    );
    expect(resB.workspaceId).toBe(WS_B);
    expect(resB.emailMessageId).toBe(msgB.id);

    // B advanced; A is untouched.
    const rowA = await prisma.emailMessage.findUnique({ where: { id: msgA.id } });
    const rowB = await prisma.emailMessage.findUnique({ where: { id: msgB.id } });
    expect(rowA?.status).toBe('SENT');
    expect(rowB?.status).toBe('DELIVERED');

    // The event row exists in B's workspace, and NONE in A for this provider id.
    const inB = await prisma.emailEngagementEvent.findMany({ where: { workspaceId: WS_B, emailMessageId: msgB.id } });
    expect(inB).toHaveLength(1);
    expect(inB[0].workspaceId).toBe(WS_B);
    const inA = await prisma.emailEngagementEvent.findMany({ where: { workspaceId: WS_A, emailMessageId: msgB.id } });
    expect(inA).toHaveLength(0);
  });

  it('UNMATCHED: an event for an unknown provider id is a clean no-op (nothing persisted)', async () => {
    const res = await service.recordEngagementEvent(
      capture({ RecordType: 'Delivery', MessageID: `pmid-nobody-${Date.now()}`, DeliveredAt: '2026-06-03T15:00:00Z' }),
    );
    expect(res.outcome).toBe('unmatched');
    expect(res.workspaceId).toBeNull();
    expect(res.emailMessageId).toBeNull();
  });
});
