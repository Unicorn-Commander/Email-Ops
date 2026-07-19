import { PrismaService } from '../prisma/prisma.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
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
import { EmailService } from './email.service';
import { AgentAutonomyLevel, MessageDisposition } from '@prisma/client';
import { TEST_DATABASE_URL } from '../../test/test-db';

/**
 * EmailService is the Email-Ops SoR + the EmailOpsPort contract + the agent-inbox
 * approval flow. These run against the REAL verify DB (emailops) so the RLS
 * `withWorkspace` transaction path + Prisma writes are exercised for real, with
 * the mail engine MOCKED (a fake StalwartPort — no live Stalwart server).
 *
 * Pinned behaviors (the brief's contract requirements):
 *   - compose_email mode=send → records the SoR row + hands to the engine
 *     (status from the engine result),
 *   - compose_email mode=draft → records the row PENDING_APPROVAL + stages an
 *     agent-inbox item (NO send happens),
 *   - IDEMPOTENT on (workspace, external_source, external_ref): a repeat returns
 *     the EXISTING message and queues NO second send (the engine is called once),
 *   - the agent-inbox APPROVE flow sends the staged draft (PENDING → APPROVED,
 *     message → sent),
 *   - the agent-inbox REJECT flow marks it REJECTED and never sends,
 *   - list_threads_with_contact / list_thread_messages return the SoR rows even
 *     with the engine returning nothing (degrade-clean),
 *   - the compose wire shape matches Customer-Ops' EmailOpsPort
 *     (id/thread_id/status/mode/external_source/external_ref/created_at).
 *
 * The verify DB is the same po-verify-pg the task provisions
 * (postgresql://postgres:REMOVED@127.0.0.1:55444/emailops). Tests connect as the
 * superuser owner (RLS inert under FORCE+BYPASS for owner), which is the Phase-1
 * runtime posture; the SEPARATE prisma/rls-acceptance.sql proves the fence under
 * the NOBYPASSRLS email_ops_app role.
 */

const DB_URL = TEST_DATABASE_URL;

// A configurable fake mail engine.
class FakeStalwart extends StalwartPort {
  async pollInbound(): Promise<null> {
    return null;
  }
  async moveThreadToMailbox(): Promise<boolean> {
    return false;
  }
  async moveThreadToFolder(): Promise<boolean> {
    return false;
  }
  async setThreadFlags(): Promise<boolean> {
    return false;
  }
  async emptyFolder(): Promise<number | null> {
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
  public sendCalls: Array<{ req: StalwartSendRequest; transactional: boolean }> = [];
  public threads: StalwartThread[] = [];
  public messages: StalwartMessage[] = [];
  public configured = true;
  public acceptSend = true;

  isConfigured(): boolean {
    return this.configured;
  }
  async listThreads(): Promise<StalwartThread[]> {
    return this.threads;
  }
  async listMessages(): Promise<StalwartMessage[]> {
    return this.messages;
  }
  async listFolderThreads(
    _mailbox: string,
    _query: StalwartFolderQuery,
  ): Promise<StalwartFolderThreadsResult> {
    return { threads: [] };
  }
  public threadDetails: StalwartMessageDetail[] = [];
  async getThreadDetail(): Promise<StalwartMessageDetail[]> {
    return this.threadDetails;
  }
  async setThreadRead(): Promise<boolean> {
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
    this.sendCalls.push({ req, transactional });
    if (!this.acceptSend) {
      return { accepted: false, providerMessageId: null, threadId: null, lane: 'stalwart', reason: 'rejected' };
    }
    return {
      accepted: true,
      providerMessageId: `prov-${this.sendCalls.length}`,
      threadId: req.inReplyToThreadId ?? `thread-new-${this.sendCalls.length}`,
      lane: transactional ? 'postmark' : 'stalwart',
    };
  }
}

describe('EmailService (verify DB; Stalwart MOCKED)', () => {
  let prisma: PrismaService;
  let stalwart: FakeStalwart;
  let connectedAccounts: ConnectedAccountsService;
  let service: EmailService;

  // A dedicated workspace per run so reruns don't collide.
  const WS = `0190a000-7e57-7000-8000-0000${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`;
  const UC_UID = 'uc-uid-test';

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    // Seed the workspace (owner connection bypasses RLS for this control table).
    await prisma.workspace.upsert({
      where: { id: WS },
      update: {},
      create: { id: WS, slug: `ws-${WS.slice(-6)}`, displayName: 'Email-Ops test ws' },
    });
    // A default mailbox for the workspace so sends have a From + a mailbox.
    await prisma.mailboxAccount.create({
      data: {
        workspaceId: WS,
        emailAddress: 'desk@magicunicorn.tech',
        displayName: 'Magic Unicorn Desk',
        isDefault: true,
        postmarkLane: true,
      },
    });
  });

  afterAll(async () => {
    // Clean up the test workspace + its scoped rows.
    if (prisma) {
      await prisma.agentInboxItem.deleteMany({ where: { workspaceId: WS } });
      await prisma.agent.deleteMany({ where: { workspaceId: WS } });
      await prisma.agentActionEvent.deleteMany({ where: { workspaceId: WS } });
      await prisma.emailMessage.deleteMany({ where: { workspaceId: WS } });
      await prisma.mailboxAccount.deleteMany({ where: { workspaceId: WS } });
      await prisma.workspace.deleteMany({ where: { id: WS } });
      await prisma.$disconnect();
    }
  });

  beforeEach(() => {
    stalwart = new FakeStalwart();
    connectedAccounts = {
      approveCleanupBatch: jest.fn().mockResolvedValue(null),
      undoBatch: jest.fn().mockResolvedValue(null),
    } as unknown as ConnectedAccountsService;
    service = new EmailService(prisma, stalwart, connectedAccounts, {
      handles: () => false,
      listInbox: async () => [],
      listThreadMessages: async () => [],
      send: async () => ({ accepted: false, providerMessageId: null, threadId: null, reason: 'test' }),
    } as any);
  });

  describe('compose_email — send', () => {
    it('records the SoR row + hands to the engine (status sent; wire shape matches the contract)', async () => {
      const ref = `send-${Date.now()}`;
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: 'contact-42',
        toAddress: 'jane@acme.test',
        subject: 'Following up',
        body: 'Hi Jane, checking in.',
        mode: 'send',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      // Wire shape (matches Customer-Ops EmailOpsPort.composeEmail result).
      expect(result).toMatchObject({
        status: 'sent',
        mode: 'send',
        external_source: 'customer-ops',
        external_ref: ref,
      });
      expect(typeof result.id).toBe('string');
      expect(result.created_at).toBeTruthy();
      // The engine was handed exactly one send, on the transactional (Postmark) lane.
      expect(stalwart.sendCalls).toHaveLength(1);
      expect(stalwart.sendCalls[0].transactional).toBe(true);
      expect(stalwart.sendCalls[0].req.toAddress).toBe('jane@acme.test');

      // The SoR row persisted with the provider id + sent status.
      const row = await prisma.emailMessage.findUnique({ where: { id: result.id } });
      expect(row?.status).toBe('SENT');
      expect(row?.providerMessageId).toBe('prov-1');
    });

    it('records FAILED (never throws) when the engine rejects the send (degrade-clean)', async () => {
      stalwart.acceptSend = false;
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: 'contact-77',
        toAddress: 'bob@acme.test',
        subject: 'Hi',
        body: 'Body',
        mode: 'send',
        externalSource: 'customer-ops',
        externalRef: `fail-${Date.now()}`,
      });
      expect(result.status).toBe('failed');
      const row = await prisma.emailMessage.findUnique({ where: { id: result.id } });
      expect(row?.status).toBe('FAILED');
      expect(row?.sentAt).toBeNull();
    });
  });

  describe('compose_email — autonomy enforcement (the registry dial bites)', () => {
    it('coerces a REGISTERED L1 agent send → staged draft (a human approves)', async () => {
      const key = `l1-agent-${Date.now()}`;
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'L1 Agent',
          autonomyLevel: AgentAutonomyLevel.L1_APPROVE_TO_SEND,
        },
      });
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'lead@acme.test',
        subject: 'Auto follow-up',
        body: 'From an L1 agent (it requested send).',
        mode: 'send',
        externalSource: key,
        externalRef: `l1-${Date.now()}`,
      });
      // It requested send, but the dial staged it for approval instead.
      expect(result).toMatchObject({ status: 'pending_approval', mode: 'draft' });
      expect(stalwart.sendCalls).toHaveLength(0);
      const item = await prisma.agentInboxItem.findUnique({ where: { messageId: result.id } });
      expect(item?.state).toBe('PENDING');
      expect(item?.draftedBy).toBe(key);
    });

    it('lets a REGISTERED L2 agent send autonomously (engine handed the send)', async () => {
      const key = `l2-agent-${Date.now()}`;
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'L2 Agent',
          autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
        },
      });
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'lead@acme.test',
        subject: 'Autonomous note',
        body: 'From an L2 agent.',
        mode: 'send',
        externalSource: key,
        externalRef: `l2-${Date.now()}`,
      });
      expect(result.status).toBe('sent');
      expect(result.mode).toBe('send');
      expect(stalwart.sendCalls).toHaveLength(1);
    });

    it('FAIL-SAFES an UNREGISTERED + UNTRUSTED source send → staged draft (injection guard)', async () => {
      // A source that is neither a registered agent nor on the trusted allowlist
      // (email-ops-client / customer-ops) — i.e. what a prompt-injected or spoofed
      // MCP compose would look like. It must NOT send; it stages for approval.
      const untrusted = `spoofed-source-${Date.now()}`;
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'victim@acme.test',
        subject: 'Injected send attempt',
        body: 'Should never leave without a human.',
        mode: 'send',
        externalSource: untrusted,
        externalRef: `inj-${Date.now()}`,
      });
      expect(result).toMatchObject({ status: 'pending_approval', mode: 'draft' });
      expect(stalwart.sendCalls).toHaveLength(0);
      const item = await prisma.agentInboxItem.findUnique({ where: { messageId: result.id } });
      expect(item?.state).toBe('PENDING');
    });

    it('coerces an L2 agent send to an EXTERNAL recipient when its policy requires approval', async () => {
      const key = `l2-policy-${Date.now()}`;
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'L2 Policy Agent',
          autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
          recipientPolicy: { requireApprovalForExternal: true, internalDomains: ['magicunicorn.tech'] },
        },
      });
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'person114@example.com', // external → policy requires approval
        subject: 'To an outsider',
        body: 'Should be staged, not sent.',
        mode: 'send',
        externalSource: key,
        externalRef: `l2p-${Date.now()}`,
      });
      expect(result.status).toBe('pending_approval');
      expect(stalwart.sendCalls).toHaveLength(0);
    });
  });

  describe('compose_email — kill switch + audit', () => {
    it('blocks agent compose when the workspace is paused', async () => {
      await prisma.workspace.update({ where: { id: WS }, data: { agentsPaused: true } });
      try {
        await expect(
          service.composeEmail(WS, UC_UID, {
            contactId: null,
            toAddress: 'x@acme.test',
            subject: 'Should be blocked',
            body: 'nope',
            mode: 'send',
            externalSource: 'customer-ops',
            externalRef: `paused-${Date.now()}`,
          }),
        ).rejects.toThrow(/paused/i);
      } finally {
        await prisma.workspace.update({ where: { id: WS }, data: { agentsPaused: false } });
      }
    });

    it('records an AUTONOMOUS_SEND audit event for an L2 agent send', async () => {
      const key = `l2-audit-${Date.now()}`;
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'L2 Audit',
          autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
        },
      });
      await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'lead@acme.test',
        subject: 'Audited send',
        body: 'L2.',
        mode: 'send',
        externalSource: key,
        externalRef: `l2a-${Date.now()}`,
      });
      const events = await prisma.agentActionEvent.findMany({
        where: { workspaceId: WS, kind: 'AUTONOMOUS_SEND', agentKey: key },
      });
      expect(events).toHaveLength(1);
      expect(events[0].messageId).toBeTruthy();
    });

    it('a registered agent sends FROM its own mailbox, not the workspace default', async () => {
      const ownMb = await prisma.mailboxAccount.create({
        data: {
          workspaceId: WS,
          emailAddress: 'sales-bot@magicunicorn.tech',
          displayName: 'Sales Bot',
          isDefault: false,
          postmarkLane: true,
        },
      });
      const key = `own-mb-${Date.now()}`;
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'Own Mailbox Agent',
          autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
          mailboxAccountId: ownMb.id,
        },
      });
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'lead@acme.test',
        subject: 'From my own box',
        body: '.',
        mode: 'send',
        externalSource: key,
        externalRef: `ownmb-${Date.now()}`,
      });
      const row = await prisma.emailMessage.findUnique({ where: { id: result.id } });
      expect(row?.fromAddress).toBe('sales-bot@magicunicorn.tech'); // its OWN, not desk@
      expect(row?.mailboxAccountId).toBe(ownMb.id);
      expect(stalwart.sendCalls.at(-1)?.req.fromAddress).toBe('sales-bot@magicunicorn.tech');
    });

    it('blocks a PAUSED agent (the per-agent kill switch)', async () => {
      const key = `paused-agent-${Date.now()}`;
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'Paused Agent',
          autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
          paused: true,
        },
      });
      await expect(
        service.composeEmail(WS, UC_UID, {
          contactId: null,
          toAddress: 'x@acme.test',
          subject: 'should be blocked',
          body: '.',
          mode: 'send',
          externalSource: key,
          externalRef: `pa-${Date.now()}`,
        }),
      ).rejects.toThrow(/paused/i);
    });
  });

  describe('compose_email — draft (stages the agent inbox; NO send)', () => {
    it('records PENDING_APPROVAL + an agent-inbox PENDING item, and does NOT call the engine', async () => {
      const ref = `draft-${Date.now()}`;
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: 'contact-9',
        toAddress: 'lead@acme.test',
        subject: 'Proposal follow-up',
        body: 'Drafted by an agent.',
        mode: 'draft',
        inReplyToThreadId: 'thread-9',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      expect(result).toMatchObject({ status: 'pending_approval', mode: 'draft', external_ref: ref });
      // The engine was NOT called — a draft never leaves until approved.
      expect(stalwart.sendCalls).toHaveLength(0);

      // An agent-inbox item was staged PENDING, pointing at this message.
      const item = await prisma.agentInboxItem.findUnique({
        where: { messageId: result.id },
      });
      expect(item).toBeTruthy();
      expect(item?.state).toBe('PENDING');
      expect(item?.draftedBy).toBe('customer-ops');
    });
  });

  describe('idempotency on (workspace, external_source, external_ref)', () => {
    it('a repeat compose returns the EXISTING message and queues NO second send', async () => {
      const ref = `idem-${Date.now()}`;
      const input = {
        contactId: 'contact-1',
        toAddress: 'jane@acme.test',
        subject: 'Once',
        body: 'Only once.',
        mode: 'send' as const,
        externalSource: 'customer-ops',
        externalRef: ref,
      };
      const first = await service.composeEmail(WS, UC_UID, input);
      const second = await service.composeEmail(WS, UC_UID, input);
      // Same message id back.
      expect(second.id).toBe(first.id);
      expect(second).toEqual(first);
      // The engine was called exactly ONCE across both composes.
      expect(stalwart.sendCalls).toHaveLength(1);
      // Exactly one row exists for the tuple.
      const rows = await prisma.emailMessage.findMany({
        where: { workspaceId: WS, externalSource: 'customer-ops', externalRef: ref },
      });
      expect(rows).toHaveLength(1);
    });
  });

  describe('agent-inbox approve / reject flow', () => {
    it('APPROVE sends the staged draft (PENDING → APPROVED; message → sent)', async () => {
      const ref = `appr-${Date.now()}`;
      const draft = await service.composeEmail(WS, UC_UID, {
        contactId: 'contact-5',
        toAddress: 'approve@acme.test',
        subject: 'Needs approval',
        body: 'Please approve.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      const item = await prisma.agentInboxItem.findUniqueOrThrow({
        where: { messageId: draft.id },
      });
      expect(stalwart.sendCalls).toHaveLength(0); // not sent yet.

      const res = await service.approveAgentInboxItem(WS, 'uc-approver', item.id, 'lgtm');
      expect(res).toBeTruthy();
      expect(res!.inbox.state).toBe('approved');
      expect(res!.inbox.reviewed_by_uc_uid).toBe('uc-approver');
      expect(res!.message).toBeTruthy();
      expect(res!.message?.status).toBe('sent');
      // NOW the engine was called exactly once (the approval send).
      expect(stalwart.sendCalls).toHaveLength(1);

      const msg = await prisma.emailMessage.findUnique({ where: { id: draft.id } });
      expect(msg?.status).toBe('SENT');
      expect(msg?.providerMessageId).toBe('prov-1');
    });

    it('APPROVE sends EXACTLY what was staged — cc/bcc/html/attachments survive (approval-fidelity)', async () => {
      const ref = `fidelity-${Date.now()}`;
      const draft = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'primary@acme.test',
        toAddresses: ['primary@acme.test', 'second@acme.test'],
        cc: ['cc1@acme.test'],
        bcc: ['bcc1@acme.test'],
        subject: 'Full payload',
        body: 'plain body',
        bodyHtml: '<p>rich body</p>',
        attachments: [{ blob_id: 'blob-9', name: 'deck.pdf', type: 'application/pdf' }],
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      const item = await prisma.agentInboxItem.findUniqueOrThrow({ where: { messageId: draft.id } });

      await service.approveAgentInboxItem(WS, 'uc-approver', item.id, 'ship it');
      expect(stalwart.sendCalls).toHaveLength(1);
      const sent = stalwart.sendCalls[0].req;
      // The approved send carries the FULL payload the approver reviewed — not a
      // stripped plain-text-only version.
      expect(sent.toAddresses).toEqual(['primary@acme.test', 'second@acme.test']);
      expect(sent.cc).toEqual(['cc1@acme.test']);
      expect(sent.bcc).toEqual(['bcc1@acme.test']);
      expect(sent.bodyHtml).toBe('<p>rich body</p>');
      expect(sent.attachments).toEqual([{ blobId: 'blob-9', name: 'deck.pdf', type: 'application/pdf' }]);
    });

    it('REJECT marks the message REJECTED and never sends', async () => {
      const ref = `rej-${Date.now()}`;
      const draft = await service.composeEmail(WS, UC_UID, {
        contactId: 'contact-6',
        toAddress: 'reject@acme.test',
        subject: 'Decline me',
        body: 'No.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      const item = await prisma.agentInboxItem.findUniqueOrThrow({
        where: { messageId: draft.id },
      });

      const res = await service.rejectAgentInboxItem(WS, 'uc-approver', item.id, 'off-message');
      expect(res!.inbox.state).toBe('rejected');
      expect(res!.message).toBeTruthy();
      expect(res!.message?.status).toBe('rejected');
      // The engine was never called.
      expect(stalwart.sendCalls).toHaveLength(0);
      const msg = await prisma.emailMessage.findUnique({ where: { id: draft.id } });
      expect(msg?.status).toBe('REJECTED');
    });

    it('listAgentInbox returns PENDING items by default (newest-first)', async () => {
      const ref = `list-${Date.now()}`;
      await service.composeEmail(WS, UC_UID, {
        contactId: 'contact-list',
        toAddress: 'queue@acme.test',
        subject: 'In the queue',
        body: 'Waiting.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      const items = await service.listAgentInbox(WS, UC_UID);
      expect(items.length).toBeGreaterThanOrEqual(1);
      const mine = items.find((i) => i.subject === 'In the queue');
      expect(mine).toBeTruthy();
      expect(mine!.state).toBe('pending');
      expect(mine!.to_address).toBe('queue@acme.test');
    });
  });

  describe('thread disposition — external (Gmail/M365) provider reconciliation', () => {
    // An external HUMAN mailbox owned by the caller, alongside the sovereign
    // desk@ box — moveThreadToFolderAcrossMailboxes must fall THROUGH the
    // sovereign box (FakeStalwart.moveThreadToFolder → false) to the provider.
    beforeAll(async () => {
      await prisma.mailboxAccount.create({
        data: {
          workspaceId: WS,
          emailAddress: 'me.external@gmail.test',
          displayName: 'Me (Gmail)',
          provider: 'gmail',
          kind: 'gmail',
          ownerKind: 'HUMAN',
          ownerKey: UC_UID,
          postmarkLane: false,
        },
      });
    });

    /** An EmailService whose MailProviderPort handles gmail boxes via jest mocks. */
    function externalService(overrides: Record<string, unknown> = {}) {
      const mailProvider = {
        handles: (mb: { provider: string }) => mb.provider === 'gmail',
        listInbox: async () => [],
        listThreadMessages: async () => [],
        send: async () => ({ accepted: false, providerMessageId: null, threadId: null, reason: 'test' }),
        archiveThread: jest.fn().mockResolvedValue(false),
        trashThread: jest.fn().mockResolvedValue(false),
        spamThread: jest.fn().mockResolvedValue(false),
        restoreThreadToInbox: jest.fn().mockResolvedValue(false),
        setThreadRead: jest.fn().mockResolvedValue(false),
        resolveOwnAddress: async () => null,
        ...overrides,
      };
      return {
        mailProvider,
        service: new EmailService(prisma, stalwart, connectedAccounts, mailProvider as any),
      };
    }

    it('SPAM reconciles the REAL external mailbox (spamThread) and writes the overlay', async () => {
      const threadId = `ext-spam-${Date.now()}`;
      const { mailProvider, service: svc } = externalService({
        spamThread: jest.fn().mockResolvedValue(true),
      });

      const out = await svc.applyThreadDisposition(WS, UC_UID, threadId, MessageDisposition.SPAM);

      expect(out.moved).toBe(true);
      expect(out.disposition).toBe(MessageDisposition.SPAM);
      expect(mailProvider.spamThread).toHaveBeenCalledWith(
        expect.objectContaining({ emailAddress: 'me.external@gmail.test' }),
        threadId,
      );
      // The dispatch is verb-exact: no other triage verb fired.
      expect(mailProvider.archiveThread).not.toHaveBeenCalled();
      expect(mailProvider.trashThread).not.toHaveBeenCalled();
      expect(mailProvider.restoreThreadToInbox).not.toHaveBeenCalled();
      const row = await prisma.threadDisposition.findUnique({
        where: { workspaceId_threadId: { workspaceId: WS, threadId } },
      });
      expect(row?.disposition).toBe(MessageDisposition.SPAM);
    });

    it('INBOX (restore) reconciles via restoreThreadToInbox and writes the overlay', async () => {
      const threadId = `ext-restore-${Date.now()}`;
      const { mailProvider, service: svc } = externalService({
        restoreThreadToInbox: jest.fn().mockResolvedValue(true),
      });

      const out = await svc.applyThreadDisposition(WS, UC_UID, threadId, MessageDisposition.INBOX);

      expect(out.moved).toBe(true);
      expect(out.disposition).toBe(MessageDisposition.INBOX);
      expect(mailProvider.restoreThreadToInbox).toHaveBeenCalledWith(
        expect.objectContaining({ emailAddress: 'me.external@gmail.test' }),
        threadId,
      );
      expect(mailProvider.spamThread).not.toHaveBeenCalled();
      const row = await prisma.threadDisposition.findUnique({
        where: { workspaceId_threadId: { workspaceId: WS, threadId } },
      });
      expect(row?.disposition).toBe(MessageDisposition.INBOX);
    });

    it('degrades clean: a throwing provider verb → moved:false but the overlay is STILL written', async () => {
      const threadId = `ext-spam-broken-${Date.now()}`;
      const { service: svc } = externalService({
        spamThread: jest.fn().mockRejectedValue(new Error('provider 500')),
      });

      const out = await svc.applyThreadDisposition(WS, UC_UID, threadId, MessageDisposition.SPAM);

      expect(out.moved).toBe(false);
      const row = await prisma.threadDisposition.findUnique({
        where: { workspaceId_threadId: { workspaceId: WS, threadId } },
      });
      expect(row?.disposition).toBe(MessageDisposition.SPAM);
    });
  });

  describe('reads (degrade-clean; SoR union)', () => {
    it('list_threads_with_contact returns the workspace’s own outbound thread even with the engine empty', async () => {
      const ref = `read-${Date.now()}`;
      // A sent message creates a thread row (engine returns thread-new-1).
      await service.composeEmail(WS, UC_UID, {
        contactId: 'contact-read',
        toAddress: 'reader@acme.test',
        subject: 'Hello there',
        body: 'A message body for the snippet.',
        mode: 'send',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      // Engine returns no live threads.
      stalwart.threads = [];
      const threads = await service.listThreadsWithContact(WS, UC_UID, 'contact-read');
      expect(threads.length).toBeGreaterThanOrEqual(1);
      const t = threads[0];
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('message_count');
      expect(t).toHaveProperty('participants');
    });

    it('list_thread_messages merges live previews + the SoR row (deduped by id)', async () => {
      const ref = `readm-${Date.now()}`;
      const sent = await service.composeEmail(WS, UC_UID, {
        contactId: 'contact-readm',
        toAddress: 'readerm@acme.test',
        subject: 'Threaded',
        body: 'Body text.',
        mode: 'send',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: sent.id } });
      const tid = row.threadId!;
      // A live message in the SAME thread, different id (webmail wave: the live
      // half of the merge reads the FULL thread detail, not the previews list).
      stalwart.threadDetails = [
        {
          id: 'live-msg-1',
          threadId: tid,
          from: { address: 'readerm@acme.test', name: 'Reader' },
          to: [{ address: 'desk@magicunicorn.tech', name: null }],
          subject: 'Re: Threaded',
          sentAt: '2026-06-03T00:00:00Z',
          preview: 'a reply preview',
          direction: 'received',
          cc: [],
          bcc: [],
          htmlBody: null,
          textBody: null,
          messageIdHeader: null,
          references: null,
          isUnread: false,
          flagged: false,
          attachments: [],
        },
      ];
      const messages = await service.listThreadMessages(WS, UC_UID, tid);
      const ids = messages.map((m) => m.id);
      expect(ids).toContain('live-msg-1');
      expect(ids).toContain(sent.id);
      // Preview-only contract: each message exposes a `preview`, not a full body field.
      for (const m of messages) {
        expect(m).toHaveProperty('preview');
        expect(m).not.toHaveProperty('body');
      }
    });
  });
});
