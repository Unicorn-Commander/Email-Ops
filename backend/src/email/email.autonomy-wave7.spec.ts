import { PrismaService } from '../prisma/prisma.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import {
  StalwartDraftRequest,
  StalwartSendRequest,
  StalwartSendResult,
  StalwartVacationState,
} from '../stalwart/stalwart.types';
import { EmailService } from './email.service';
import { AgentAutonomyLevel, EmailDirection, EmailMessageStatus, EmailMode } from '@prisma/client';
import { TEST_DATABASE_URL } from '../../test/test-db';

/**
 * Wave 7 — the agent-send autonomy matrix END TO END (verify DB; engine mocked):
 * "first contact needs a human; ongoing conversation flows."
 *
 * Integration-pins the full loop the pure matrix spec can't: the context the
 * service builds from REAL rows (agent-linked mailbox = Class B, MailDomain ∪
 * recipientPolicy = internal, trusted_correspondents = trust, an SoR RECEIVED
 * row / the runtime attestation = the in-thread proof), the staged item's
 * payload.policy reasons, the approve-path LEARNING (default on;
 * trustRecipients:false skips), the transparency footer + X-UC-Agent-Autoreply
 * stamp on autonomous sends, the auto-sent audit feed, the full item detail
 * read, and that the human trusted-source lane is byte-identical.
 */

const DB_URL = TEST_DATABASE_URL;

class FakeStalwart extends StalwartPort {
  public sendCalls: Array<{ req: StalwartSendRequest; transactional: boolean }> = [];
  public acceptSend = true;
  isConfigured(): boolean {
    return true;
  }
  async send(
    _mailbox: string,
    req: StalwartSendRequest,
    transactional: boolean,
  ): Promise<StalwartSendResult> {
    this.sendCalls.push({ req, transactional });
    if (!this.acceptSend) {
      return { accepted: false, providerMessageId: null, threadId: null, lane: 'stalwart', reason: 'rejected' };
    }
    return {
      accepted: true,
      providerMessageId: `prov-${this.sendCalls.length}`,
      threadId: req.inReplyToThreadId ?? `thread-${this.sendCalls.length}`,
      lane: 'stalwart',
    };
  }
  // Degrade-clean no-ops for the rest of the port surface.
  async listThreads() {
    return [];
  }
  async listMessages() {
    return [];
  }
  async listFolderThreads() {
    return { threads: [] };
  }
  async getThreadDetail() {
    return [];
  }
  async setThreadRead(): Promise<boolean> {
    return false;
  }
  async setThreadFlags(): Promise<boolean> {
    return false;
  }
  async moveThreadToFolder(): Promise<boolean> {
    return false;
  }
  async moveThreadToMailbox(): Promise<boolean> {
    return false;
  }
  async emptyFolder(): Promise<number | null> {
    return null;
  }
  async getMailboxCounts(): Promise<null> {
    return null;
  }
  async downloadBlob(): Promise<null> {
    return null;
  }
  async uploadBlob(): Promise<null> {
    return null;
  }
  async getMessageHeaders(): Promise<null> {
    return null;
  }
  async pollInbound(): Promise<null> {
    return null;
  }
  async listFolders(): Promise<never[]> {
    return [];
  }
  async createFolder(): Promise<null> {
    return null;
  }
  async renameFolder(): Promise<boolean> {
    return false;
  }
  async deleteFolder(): Promise<boolean> {
    return false;
  }
  async saveDraft(_m: string, _d: StalwartDraftRequest): Promise<{ id: string } | null> {
    return null;
  }
  async updateDraft(): Promise<{ id: string } | null> {
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
}

describe('EmailService — Wave 7 autonomy matrix (verify DB; engine MOCKED)', () => {
  let prisma: PrismaService;
  let stalwart: FakeStalwart;
  let service: EmailService;

  // A dedicated workspace per run so reruns don't collide (existing pattern).
  const WS = `0190a000-7e57-7000-8000-70${Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')}77`;
  const UC_UID = 'uc-wave7-tester';
  // MailDomain.domain is GLOBALLY unique — a per-run domain avoids collisions.
  const INTERNAL_DOMAIN = `int-${Math.random().toString(36).slice(2, 8)}.test`;
  let agentMailboxId = '';

  const L1_KEY = 'w7-l1-bot';
  const L2_KEY = 'w7-l2-bot';

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.workspace.upsert({
      where: { id: WS },
      update: {},
      create: { id: WS, slug: `ws-${WS.slice(-8)}`, displayName: 'Wave 7 matrix ws' },
    });
    // The workspace's default (SHARED → Class A) mailbox.
    await prisma.mailboxAccount.create({
      data: { workspaceId: WS, emailAddress: `desk@${INTERNAL_DOMAIN}`, isDefault: true },
    });
    // The agents' OWN mailbox (Class B via Agent.mailboxAccountId).
    const agentMb = await prisma.mailboxAccount.create({
      data: { workspaceId: WS, emailAddress: `bots@${INTERNAL_DOMAIN}`, ownerKind: 'AGENT' },
    });
    agentMailboxId = agentMb.id;
    await prisma.mailDomain.create({ data: { workspaceId: WS, domain: INTERNAL_DOMAIN } });
    await prisma.agent.create({
      data: {
        workspaceId: WS,
        key: L1_KEY,
        displayName: 'W7 L1 Bot',
        autonomyLevel: AgentAutonomyLevel.L1_APPROVE_TO_SEND,
        mailboxAccountId: agentMb.id,
      },
    });
    await prisma.agent.create({
      data: {
        workspaceId: WS,
        key: L2_KEY,
        displayName: 'W7 L2 Bot',
        autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
        mailboxAccountId: agentMb.id,
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.agentInboxItem.deleteMany({ where: { workspaceId: WS } });
      await prisma.agentActionEvent.deleteMany({ where: { workspaceId: WS } });
      await prisma.trustedCorrespondent.deleteMany({ where: { workspaceId: WS } });
      await prisma.emailMessage.deleteMany({ where: { workspaceId: WS } });
      await prisma.agent.deleteMany({ where: { workspaceId: WS } });
      await prisma.mailDomain.deleteMany({ where: { workspaceId: WS } });
      await prisma.mailboxAccount.deleteMany({ where: { workspaceId: WS } });
      await prisma.workspace.deleteMany({ where: { id: WS } });
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    stalwart = new FakeStalwart();
    const connectedAccounts = {
      approveCleanupBatch: jest.fn().mockResolvedValue(null),
    } as unknown as ConnectedAccountsService;
    service = new EmailService(prisma, stalwart, connectedAccounts, {
      handles: () => false,
      listInbox: async () => [],
      listThreadMessages: async () => [],
      send: async () => ({ accepted: false, providerMessageId: null, threadId: null, reason: 'test' }),
    } as any);
    delete process.env.AGENT_AUTONOMOUS_SEND_ENABLED;
    await prisma.trustedCorrespondent.deleteMany({ where: { workspaceId: WS } });
  });

  function compose(key: string, overrides: Record<string, unknown> = {}) {
    return service.composeEmail(WS, UC_UID, {
      contactId: null,
      toAddress: `partner@ext.test`,
      subject: 'Wave 7',
      body: 'matrix',
      mode: 'send',
      externalSource: key,
      externalRef: `w7-${Math.random().toString(36).slice(2)}`,
      draftedBy: key,
      ...overrides,
    } as any);
  }

  async function policyOf(messageId: string) {
    const item = await prisma.agentInboxItem.findUnique({ where: { messageId } });
    return {
      item,
      policy: (item?.payload as { policy?: { decision?: string; reasons?: { code: string; message: string }[] } } | null)
        ?.policy,
    };
  }

  it('L1 internal → AUTONOMOUS SEND (the new internal-autonomous semantics)', async () => {
    const res = await compose(L1_KEY, { toAddress: `teammate@${INTERNAL_DOMAIN}` });
    expect(res.status).toBe('sent');
    expect(stalwart.sendCalls).toHaveLength(1);
    // An audit row records the autonomous send.
    const events = await prisma.agentActionEvent.findMany({
      where: { workspaceId: WS, kind: 'AUTONOMOUS_SEND', agentKey: L1_KEY, messageId: res.id },
    });
    expect(events).toHaveLength(1);
  });

  it('L1 external → HELD for approval with an l1-external policy reason', async () => {
    const res = await compose(L1_KEY, { toAddress: 'partner@ext.test' });
    expect(res).toMatchObject({ status: 'pending_approval', mode: 'draft' });
    expect(stalwart.sendCalls).toHaveLength(0);
    const { item, policy } = await policyOf(res.id);
    expect(item?.state).toBe('PENDING');
    expect(policy?.decision).toBe('hold');
    expect(policy?.reasons?.map((r) => r.code)).toEqual(['l1-external']);
    // The cheap summary suffix names the first hold code.
    expect(item?.summary).toContain('held: l1-external');
  });

  it('L2 FIRST CONTACT (untrusted external, even in-thread) → HELD with first-contact reason', async () => {
    const threadId = `w7-thread-${Date.now()}`;
    await prisma.emailMessage.create({
      data: {
        workspaceId: WS,
        threadId,
        direction: EmailDirection.RECEIVED,
        status: EmailMessageStatus.SENT,
        mode: EmailMode.SEND,
        fromAddress: 'stranger@ext.test',
        subject: 'inbound',
      },
    });
    const res = await compose(L2_KEY, { toAddress: 'stranger@ext.test', inReplyToThreadId: threadId });
    expect(res.status).toBe('pending_approval');
    const { policy } = await policyOf(res.id);
    expect(policy?.reasons?.map((r) => r.code)).toEqual(['first-contact']);
    expect(policy?.reasons?.[0].message).toContain('stranger@ext.test');
  });

  it('L2 TRUSTED + IN-THREAD (SoR RECEIVED row proves the inbound) → AUTONOMOUS SEND', async () => {
    const threadId = `w7-thread-${Date.now()}-t`;
    await prisma.emailMessage.create({
      data: {
        workspaceId: WS,
        threadId,
        direction: EmailDirection.RECEIVED,
        status: EmailMessageStatus.SENT,
        mode: EmailMode.SEND,
        fromAddress: 'Jane Partner <jane@ext.test>'.match(/<(.+)>/)![1],
        subject: 'inbound',
      },
    });
    await prisma.trustedCorrespondent.create({
      data: { workspaceId: WS, address: 'jane@ext.test', source: 'MANUAL' },
    });
    const res = await compose(L2_KEY, { toAddress: 'jane@ext.test', inReplyToThreadId: threadId });
    expect(res.status).toBe('sent');
    expect(stalwart.sendCalls).toHaveLength(1);
  });

  it('Wave 10: L2 + DOMAIN trust (acme.com) → in-thread reply to a NEVER-seen address at that domain AUTONOMOUS SENDS', async () => {
    const threadId = `w10-thread-${Date.now()}-d`;
    await prisma.emailMessage.create({
      data: {
        workspaceId: WS,
        threadId,
        direction: EmailDirection.RECEIVED,
        status: EmailMessageStatus.SENT,
        mode: EmailMode.SEND,
        fromAddress: 'newbie@acme.com',
        subject: 'inbound',
      },
    });
    // Only the DOMAIN is trusted — newbie@acme.com was never individually approved.
    await prisma.trustedCorrespondent.create({
      data: { workspaceId: WS, address: 'acme.com', scope: 'DOMAIN', source: 'MANUAL' },
    });
    const res = await compose(L2_KEY, { toAddress: 'newbie@acme.com', inReplyToThreadId: threadId });
    expect(res.status).toBe('sent');
  });

  it('Wave 10: DOMAIN trust for acme.com does NOT trust a recipient at a different domain (still HELD)', async () => {
    const threadId = `w10-thread-${Date.now()}-x`;
    await prisma.emailMessage.create({
      data: {
        workspaceId: WS,
        threadId,
        direction: EmailDirection.RECEIVED,
        status: EmailMessageStatus.SENT,
        mode: EmailMode.SEND,
        fromAddress: 'someone@other.test',
        subject: 'inbound',
      },
    });
    await prisma.trustedCorrespondent.create({
      data: { workspaceId: WS, address: 'acme.com', scope: 'DOMAIN', source: 'MANUAL' },
    });
    const res = await compose(L2_KEY, {
      toAddress: 'someone@other.test',
      inReplyToThreadId: threadId,
    });
    expect(res.status).toBe('pending_approval');
    const { policy } = await policyOf(res.id);
    expect(policy?.reasons?.map((r) => r.code)).toContain('first-contact');
  });

  it('L2 TRUSTED + runtime ATTESTATION (no SoR row) → AUTONOMOUS SEND, footer + loop stamp applied', async () => {
    await prisma.trustedCorrespondent.create({
      data: { workspaceId: WS, address: 'jane@ext.test', source: 'MANUAL' },
    });
    const res = await compose(L2_KEY, {
      toAddress: 'jane@ext.test',
      inReplyToThreadId: `w7-att-${Date.now()}`,
      body: 'On it.',
      bodyHtml: '<p>On it.</p>',
      externalSource: 'agent-reply-runtime',
      draftedBy: L2_KEY,
      agentAutoreply: true,
      inboundReplyAttestation: { fromAddress: 'Jane <JANE@ext.test>' },
      transparencyFooter: {
        text: '\n\n— W7 L2 Bot · AI agent, sent autonomously',
        html: '<p>— W7 L2 Bot · AI agent, sent autonomously</p>',
      },
    });
    expect(res.status).toBe('sent');
    const sent = stalwart.sendCalls[0].req;
    // Loop guard (a): the auto-reply stamp rides on the wire.
    expect(sent.headers).toEqual([{ name: 'X-UC-Agent-Autoreply', value: '1' }]);
    // The transparency footer landed in BOTH bodies and in the SoR row.
    expect(sent.body).toContain('AI agent, sent autonomously');
    expect(sent.bodyHtml).toContain('AI agent, sent autonomously');
    const row = await prisma.emailMessage.findUnique({ where: { id: res.id } });
    expect(row?.body).toContain('AI agent, sent autonomously');
  });

  it('a human-APPROVED draft keeps the normal signature — NO transparency footer', async () => {
    // Untrusted external → held even though a footer was offered.
    const res = await compose(L2_KEY, {
      toAddress: 'held@ext.test',
      inReplyToThreadId: null,
      transparencyFooter: { text: '\n\nFOOTER', html: '<p>FOOTER</p>' },
    });
    expect(res.status).toBe('pending_approval');
    const { item } = await policyOf(res.id);
    const approved = await service.approveAgentInboxItem(WS, UC_UID, item!.id, null);
    expect(approved?.message?.status).toBe('sent');
    const sent = stalwart.sendCalls[0].req;
    expect(sent.body).not.toContain('FOOTER');
    const row = await prisma.emailMessage.findUnique({ where: { id: res.id } });
    expect(row?.body).not.toContain('FOOTER');
  });

  it('a REJECTED send does NOT approve the item — it stays PENDING, message FAILED, approval throws', async () => {
    // Confirm-on-success-only regression: if the engine will not accept the send,
    // approving must surface the failure and leave the draft PENDING for a retry —
    // never report it approved, which would silently lose the reply.
    const res = await compose(L2_KEY, { toAddress: 'held@ext.test', inReplyToThreadId: null });
    expect(res.status).toBe('pending_approval');
    const { item } = await policyOf(res.id);

    stalwart.acceptSend = false;
    await expect(service.approveAgentInboxItem(WS, UC_UID, item!.id, null)).rejects.toThrow(
      /rejected|could not be sent/i,
    );

    // The item was NOT flipped to APPROVED, and the message is stamped FAILED truthfully.
    const afterItem = await prisma.agentInboxItem.findUnique({ where: { id: item!.id } });
    expect(afterItem?.state).toBe('PENDING');
    const row = await prisma.emailMessage.findUnique({ where: { id: res.id } });
    expect(row?.status).toBe('FAILED');
  });

  it('L2 attachment → HELD (attachment reason)', async () => {
    await prisma.trustedCorrespondent.create({
      data: { workspaceId: WS, address: 'jane@ext.test', source: 'MANUAL' },
    });
    const res = await compose(L2_KEY, {
      toAddress: 'jane@ext.test',
      inReplyToThreadId: `w7-att2-${Date.now()}`,
      inboundReplyAttestation: { fromAddress: 'jane@ext.test' },
      attachments: [{ blob_id: 'b1', name: 'x.pdf', type: 'application/pdf' }],
    });
    expect(res.status).toBe('pending_approval');
    const { policy } = await policyOf(res.id);
    expect(policy?.reasons?.map((r) => r.code)).toEqual(['attachment']);
  });

  it('L2 bulk (6 external) → HELD (bulk-external among the reasons)', async () => {
    const many = Array.from({ length: 6 }, (_, i) => `p${i}@ext.test`);
    for (const address of many) {
      await prisma.trustedCorrespondent.create({ data: { workspaceId: WS, address, source: 'MANUAL' } });
    }
    const res = await compose(L2_KEY, {
      toAddress: many[0],
      toAddresses: many,
      inReplyToThreadId: `w7-bulk-${Date.now()}`,
      inboundReplyAttestation: { fromAddress: many[0] },
    });
    expect(res.status).toBe('pending_approval');
    const { policy } = await policyOf(res.id);
    expect(policy?.reasons?.map((r) => r.code)).toContain('bulk-external');
  });

  it('Class A: an L2 send from the workspace-default mailbox is ALWAYS held', async () => {
    const key = `w7-classa-${Date.now()}`;
    await prisma.agent.create({
      data: {
        workspaceId: WS,
        key,
        displayName: 'No-Mailbox Bot',
        autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
      },
    });
    const res = await compose(key, { toAddress: `teammate@${INTERNAL_DOMAIN}` });
    expect(res.status).toBe('pending_approval');
    const { policy } = await policyOf(res.id);
    expect(policy?.reasons?.map((r) => r.code)).toEqual(['class-a-mailbox']);
  });

  it('AGENT_AUTONOMOUS_SEND_ENABLED=false stages EXTERNAL agent auto-sends (internal unaffected)', async () => {
    process.env.AGENT_AUTONOMOUS_SEND_ENABLED = 'false';
    try {
      await prisma.trustedCorrespondent.create({
        data: { workspaceId: WS, address: 'jane@ext.test', source: 'MANUAL' },
      });
      const res = await compose(L2_KEY, {
        toAddress: 'jane@ext.test',
        inReplyToThreadId: `w7-switch-${Date.now()}`,
        inboundReplyAttestation: { fromAddress: 'jane@ext.test' },
      });
      expect(res.status).toBe('pending_approval');
      const { policy } = await policyOf(res.id);
      expect(policy?.reasons?.map((r) => r.code)).toEqual(['autonomous-send-disabled']);
      // Internal L1/L2 mail still flows (the switch gates EXTERNAL autonomy).
      const internal = await compose(L2_KEY, { toAddress: `teammate@${INTERNAL_DOMAIN}` });
      expect(internal.status).toBe('sent');
    } finally {
      delete process.env.AGENT_AUTONOMOUS_SEND_ENABLED;
    }
  });

  it('the human trusted-source lane is UNCHANGED: sends to anyone, no policy payload, no footer', async () => {
    const res = await service.composeEmail(WS, UC_UID, {
      contactId: null,
      toAddress: 'total-stranger@ext.test',
      subject: 'From the web client',
      body: 'human mail',
      mode: 'send',
      externalSource: 'email-ops-client',
      externalRef: `w7-human-${Date.now()}`,
    });
    expect(res.status).toBe('sent');
    expect(stalwart.sendCalls[0].req.headers).toBeUndefined();
    expect(stalwart.sendCalls[0].req.body).toBe('human mail');
  });

  describe('approve-path learning', () => {
    it('approving an EMAIL draft LEARNS its external recipients (default on; count increments)', async () => {
      const stage = await compose(L1_KEY, {
        toAddress: 'learn-me@ext.test',
        cc: ['also-learn@ext.test', `internal@${INTERNAL_DOMAIN}`],
      });
      const { item } = await policyOf(stage.id);
      await service.approveAgentInboxItem(WS, 'uc-approver', item!.id, 'lgtm');

      const rows = await prisma.trustedCorrespondent.findMany({
        where: { workspaceId: WS },
        orderBy: { address: 'asc' },
      });
      expect(rows.map((r) => r.address)).toEqual(['also-learn@ext.test', 'learn-me@ext.test']);
      expect(rows.every((r) => r.source === 'APPROVAL' && r.approvalCount === 1)).toBe(true);
      expect(rows.every((r) => r.addedByUcUid === 'uc-approver')).toBe(true);
      expect(rows.every((r) => r.lastApprovedAt != null)).toBe(true);

      // A second approval to the same address INCREMENTS, never duplicates.
      const again = await compose(L1_KEY, { toAddress: 'learn-me@ext.test' });
      const { item: item2 } = await policyOf(again.id);
      await service.approveAgentInboxItem(WS, 'uc-approver', item2!.id, null);
      const row = await prisma.trustedCorrespondent.findUnique({
        where: {
          workspaceId_scope_address: {
            workspaceId: WS,
            scope: 'ADDRESS',
            address: 'learn-me@ext.test',
          },
        },
      });
      expect(row?.approvalCount).toBe(2);
    });

    it('trustRecipients:false approves + sends WITHOUT learning', async () => {
      const stage = await compose(L1_KEY, { toAddress: 'never-learn@ext.test' });
      const { item } = await policyOf(stage.id);
      const res = await service.approveAgentInboxItem(WS, 'uc-approver', item!.id, null, false);
      expect(res?.message?.status).toBe('sent');
      const rows = await prisma.trustedCorrespondent.findMany({ where: { workspaceId: WS } });
      expect(rows).toHaveLength(0);
    });

    it('rejection NEVER learns', async () => {
      const stage = await compose(L1_KEY, { toAddress: 'rejected@ext.test' });
      const { item } = await policyOf(stage.id);
      await service.rejectAgentInboxItem(WS, 'uc-approver', item!.id, 'no');
      const rows = await prisma.trustedCorrespondent.findMany({ where: { workspaceId: WS } });
      expect(rows).toHaveLength(0);
    });

    it('the learned trust CLOSES THE LOOP: the next in-thread L2 reply auto-sends', async () => {
      // First contact → held.
      const threadId = `w7-loop-${Date.now()}`;
      const first = await compose(L2_KEY, {
        toAddress: 'loop@ext.test',
        inReplyToThreadId: threadId,
        inboundReplyAttestation: { fromAddress: 'loop@ext.test' },
      });
      expect(first.status).toBe('pending_approval');
      // A human approves once (learning on).
      const { item } = await policyOf(first.id);
      await service.approveAgentInboxItem(WS, 'uc-approver', item!.id, null);
      // The NEXT in-thread reply flows autonomously.
      const second = await compose(L2_KEY, {
        toAddress: 'loop@ext.test',
        inReplyToThreadId: threadId,
        inboundReplyAttestation: { fromAddress: 'loop@ext.test' },
      });
      expect(second.status).toBe('sent');
    });
  });

  describe('Wave 7 read surfaces', () => {
    it('the auto-sent feed returns AUTONOMOUS_SEND events newest-first with the FULL message', async () => {
      const sent = await compose(L1_KEY, {
        toAddress: `teammate@${INTERNAL_DOMAIN}`,
        subject: 'Feed me',
        body: 'feed body',
        bodyHtml: '<p>feed body</p>',
      });
      expect(sent.status).toBe('sent');
      const feed = await service.listAutoSentFeed(WS, UC_UID);
      const mine = feed.find((f) => f.message?.id === sent.id);
      expect(mine).toBeTruthy();
      expect(mine!.agentKey).toBe(L1_KEY);
      expect(mine!.createdAt).toBeTruthy();
      expect(mine!.message).toMatchObject({
        subject: 'Feed me',
        fromAddress: `bots@${INTERNAL_DOMAIN}`,
        toAddress: `teammate@${INTERNAL_DOMAIN}`,
        body: 'feed body',
        textBody: 'feed body',
        bodyHtml: '<p>feed body</p>',
        htmlBody: '<p>feed body</p>',
        attachments: [],
        status: 'sent',
      });
    });

    it('the item DETAIL exposes the FULL staged message + payload.policy', async () => {
      const stage = await compose(L1_KEY, {
        toAddress: 'detail@ext.test',
        toAddresses: ['detail@ext.test', 'second@ext.test'],
        cc: ['cc@ext.test'],
        subject: 'Detail me',
        body: 'plain',
        bodyHtml: '<p>rich</p>',
        attachments: [{ blob_id: 'blob-7', name: 'brief.pdf', type: 'application/pdf' }],
      });
      const { item } = await policyOf(stage.id);
      const detail = await service.getAgentInboxItemDetail(WS, UC_UID, item!.id);
      expect(detail).toBeTruthy();
      expect(detail!.state).toBe('pending');
      expect((detail!.payload as { policy?: { decision?: string } })?.policy?.decision).toBe('hold');
      expect(detail!.message).toMatchObject({
        id: stage.id,
        subject: 'Detail me',
        toAddress: 'detail@ext.test',
        toAddresses: ['detail@ext.test', 'second@ext.test'],
        ccAddresses: ['cc@ext.test'],
        body: 'plain',
        bodyHtml: '<p>rich</p>',
        htmlBody: '<p>rich</p>',
        attachments: [{ blobId: 'blob-7', name: 'brief.pdf', type: 'application/pdf' }],
        status: 'pending_approval',
        mode: 'draft',
      });
      // A foreign/unknown id resolves to null (the tenant fence).
      expect(await service.getAgentInboxItemDetail(WS, UC_UID, 'no-such-item')).toBeNull();
    });
  });
});
