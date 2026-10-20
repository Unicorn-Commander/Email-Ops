import { ConflictException } from '@nestjs/common';
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
import {
  AgentAutonomyLevel,
  AgentInboxKind,
  MessageDisposition,
  WorkspaceRole,
} from '@prisma/client';
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
      return {
        accepted: false,
        providerMessageId: null,
        threadId: null,
        lane: 'stalwart',
        reason: 'rejected',
      };
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
      send: async () => ({
        accepted: false,
        providerMessageId: null,
        threadId: null,
        reason: 'test',
      }),
    } as any);
  });

  describe('compose_email — send', () => {
    it('refuses an attachment before staging when the selected lane cannot carry it', async () => {
      (stalwart as any).supportsAttachments = jest.fn().mockReturnValue(false);
      const ref = `attachment-refusal-${Date.now()}`;
      await expect(
        service.composeEmail(WS, UC_UID, {
          contactId: null,
          toAddress: 'refused@acme.test',
          subject: 'Should not stage',
          body: 'No silent drop.',
          mode: 'draft',
          externalSource: 'customer-ops',
          externalRef: ref,
          attachments: [
            {
              filename: 'brief.pdf',
              contentType: 'application/pdf',
              contentBase64: 'JVBERi0xLjQ=',
            },
          ],
        }),
      ).rejects.toThrow(/compose was refused before anything was sent/);
      await expect(
        prisma.emailMessage.findFirst({ where: { workspaceId: WS, externalRef: ref } }),
      ).resolves.toBeNull();
    });

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

    it('lets a REGISTERED L2 agent send autonomously from ITS OWN mailbox to an INTERNAL recipient', async () => {
      // Wave 7: L2 external requires routine (first-contact gating) — an
      // autonomous send now needs a Class-B (agent-linked) mailbox AND an
      // internal recipient (or the full routine-external checklist). This test
      // pins the internal-autonomous lane.
      const key = `l2-agent-${Date.now()}`;
      const ownMb = await prisma.mailboxAccount.create({
        data: {
          workspaceId: WS,
          emailAddress: `l2-bot-${Date.now()}@magicunicorn.tech`,
          isDefault: false,
          postmarkLane: true,
        },
      });
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'L2 Agent',
          autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
          mailboxAccountId: ownMb.id,
          recipientPolicy: { internalDomains: ['acme.test'] },
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

    it('Wave 7: an L2 send from the workspace-default (non-agent) mailbox is held — Class A always drafts', async () => {
      const key = `l2-classa-${Date.now()}`;
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'L2 Class-A Agent',
          autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
        },
      });
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'lead@acme.test',
        subject: 'Should stage',
        body: 'The agent has no mailbox of its own — it composes as the shared desk.',
        mode: 'send',
        externalSource: key,
        externalRef: `l2ca-${Date.now()}`,
      });
      expect(result).toMatchObject({ status: 'pending_approval', mode: 'draft' });
      expect(stalwart.sendCalls).toHaveLength(0);
      const item = await prisma.agentInboxItem.findUnique({ where: { messageId: result.id } });
      const policy = (item?.payload as { policy?: { reasons?: { code: string }[] } })?.policy;
      expect(policy?.reasons?.some((r) => r.code === 'class-a-mailbox')).toBe(true);
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
          recipientPolicy: {
            requireApprovalForExternal: true,
            internalDomains: ['magicunicorn.tech'],
          },
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
      // Wave 7: L2 external requires routine (first-contact gating) — the
      // autonomous lane now needs a Class-B mailbox + an internal recipient.
      const key = `l2-audit-${Date.now()}`;
      const ownMb = await prisma.mailboxAccount.create({
        data: {
          workspaceId: WS,
          emailAddress: `l2-audit-${Date.now()}@magicunicorn.tech`,
          isDefault: false,
          postmarkLane: true,
        },
      });
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'L2 Audit',
          autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
          mailboxAccountId: ownMb.id,
          recipientPolicy: { internalDomains: ['acme.test'] },
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
          // Wave 7: L2 external requires routine (first-contact gating) — the
          // recipient is made internal so the send still flows and this test
          // keeps pinning the send-identity behavior it always pinned.
          recipientPolicy: { internalDomains: ['acme.test'] },
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
      const agent = await prisma.agent.create({
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
      ).rejects.toBeInstanceOf(ConflictException);

      await prisma.agent.update({ where: { id: agent.id }, data: { paused: false } });
      const resumed = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'x@acme.test',
        subject: 'after resume',
        body: 'Routine reply.',
        mode: 'draft',
        externalSource: key,
        externalRef: `pa-resumed-${Date.now()}`,
      });
      expect(resumed.status).toBe('pending_approval');
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
      expect(result).toMatchObject({
        status: 'pending_approval',
        mode: 'draft',
        external_ref: ref,
      });
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

    it('stamps the content approval tier and exposes it in the inbox view', async () => {
      const routine = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'routine@acme.test',
        subject: 'Re: Tuesday',
        body: 'Thanks, that works for me.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: `routine-tier-${Date.now()}`,
      });
      const routineItem = await prisma.agentInboxItem.findUniqueOrThrow({
        where: { messageId: routine.id },
      });
      expect(routineItem.approvalTier).toBe('MAILBOX_OWNER');
      expect(routineItem.approvalReason).toBeNull();

      const commercial = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'commercial@acme.test',
        subject: 'Pricing proposal',
        body: 'We can offer 20% off the $900 package.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: `commercial-tier-${Date.now()}`,
      });
      const commercialItem = await prisma.agentInboxItem.findUniqueOrThrow({
        where: { messageId: commercial.id },
      });
      expect(commercialItem.approvalTier).toBe('OWNER_ADMIN');
      expect(commercialItem.approvalReason).toMatch(/currency amount|percentage/);

      const listed = await service.listAgentInbox(WS, UC_UID);
      const view = listed.find((item) => item.id === commercialItem.id);
      expect(view).toMatchObject({
        approval_tier: 'owner_admin',
        approval_reason: commercialItem.approvalReason,
      });
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
    it('lets the mailbox owner approve routine mail but requires owner/admin for commercial drafts', async () => {
      const mailbox = await prisma.mailboxAccount.create({
        data: {
          workspaceId: WS,
          emailAddress: `james-${Date.now()}@magicunicorn.tech`,
          displayName: 'James',
          ownerKind: 'HUMAN',
          ownerKey: UC_UID,
        },
      });
      const routine = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        fromAddress: mailbox.emailAddress,
        toAddress: 'routine-approval@acme.test',
        subject: 'Re: Tuesday',
        body: 'Thanks, that works for me.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: `routine-approval-${Date.now()}`,
      });
      const routineItem = await prisma.agentInboxItem.findUniqueOrThrow({
        where: { messageId: routine.id },
      });
      expect(routineItem.approvalTier).toBe('MAILBOX_OWNER');
      const routineApproved = await service.approveAgentInboxItem(
        WS,
        UC_UID,
        routineItem.id,
        null,
        false,
        false,
        WorkspaceRole.MEMBER,
      );
      expect(routineApproved?.inbox.state).toBe('approved');

      const draft = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'commercial-approval@acme.test',
        subject: 'Contract pricing',
        body: 'Please approve the $900 contract.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: `tier-approval-${Date.now()}`,
      });
      const item = await prisma.agentInboxItem.findUniqueOrThrow({
        where: { messageId: draft.id },
      });

      await expect(
        service.approveAgentInboxItem(
          WS,
          'uc-mailbox-member',
          item.id,
          null,
          false,
          false,
          WorkspaceRole.MEMBER,
        ),
      ).rejects.toThrow('This draft requires a workspace OWNER or ADMIN to approve.');
      expect((await prisma.agentInboxItem.findUnique({ where: { id: item.id } }))?.state).toBe(
        'PENDING',
      );

      const approved = await service.approveAgentInboxItem(
        WS,
        UC_UID,
        item.id,
        null,
        false,
        false,
        WorkspaceRole.ADMIN,
      );
      expect(approved?.inbox.state).toBe('approved');
    });

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
      const item = await prisma.agentInboxItem.findUniqueOrThrow({
        where: { messageId: draft.id },
      });

      await service.approveAgentInboxItem(WS, 'uc-approver', item.id, 'ship it');
      expect(stalwart.sendCalls).toHaveLength(1);
      const sent = stalwart.sendCalls[0].req;
      // The approved send carries the FULL payload the approver reviewed — not a
      // stripped plain-text-only version.
      expect(sent.toAddresses).toEqual(['primary@acme.test', 'second@acme.test']);
      expect(sent.cc).toEqual(['cc1@acme.test']);
      expect(sent.bcc).toEqual(['bcc1@acme.test']);
      expect(sent.bodyHtml).toBe('<p>rich body</p>');
      expect(sent.attachments).toEqual([
        { blobId: 'blob-9', name: 'deck.pdf', type: 'application/pdf' },
      ]);
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

    it('lists and approves a NOTICE without requiring a message or sending mail', async () => {
      const item = await prisma.agentInboxItem.create({
        data: {
          workspaceId: WS,
          kind: AgentInboxKind.NOTICE,
          approvalTier: 'MAILBOX_OWNER',
          draftedBy: 'mail-rule:notice-rule',
          summary: 'Security rule: sender@acme.test · Important',
          payload: {
            type: 'mail_rule_notice',
            ruleId: 'notice-rule',
            ruleName: 'Security rule',
            mailboxId: 'mailbox-1',
            mailboxAddress: 'desk@magicunicorn.tech',
            threadId: 'thread-1',
            from: 'sender@acme.test',
            subject: 'Important',
            receivedAt: '2026-10-20T12:00:00.000Z',
          },
        },
      });

      const listed = await service.listAgentInbox(WS, UC_UID);
      expect(listed.find((entry) => entry.id === item.id)).toMatchObject({
        kind: 'NOTICE',
        message_id: null,
        payload: expect.objectContaining({ type: 'mail_rule_notice', ruleId: 'notice-rule' }),
      });

      const result = await service.approveAgentInboxItem(WS, UC_UID, item.id, 'seen');
      expect(result).toMatchObject({ inbox: { kind: 'NOTICE', state: 'approved' }, message: null });
      expect(stalwart.sendCalls).toHaveLength(0);
      expect((await prisma.agentInboxItem.findUnique({ where: { id: item.id } }))?.state).toBe(
        'APPROVED',
      );
    });

    it('rejects a NOTICE by dismissing only the inbox row', async () => {
      const item = await prisma.agentInboxItem.create({
        data: {
          workspaceId: WS,
          kind: AgentInboxKind.NOTICE,
          approvalTier: 'MAILBOX_OWNER',
          draftedBy: 'mail-rule:notice-dismiss',
          summary: 'Dismiss me',
          payload: { type: 'mail_rule_notice', ruleId: 'dismiss-rule' },
        },
      });

      const result = await service.rejectAgentInboxItem(WS, UC_UID, item.id, 'not needed');
      expect(result).toMatchObject({ inbox: { kind: 'NOTICE', state: 'rejected' }, message: null });
      expect(stalwart.sendCalls).toHaveLength(0);
      expect((await prisma.agentInboxItem.findUnique({ where: { id: item.id } }))?.state).toBe(
        'REJECTED',
      );
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

    it('listAgentInbox exposes attachment name, size, and MIME type before approval', async () => {
      const ref = `attachment-list-${Date.now()}`;
      await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'attachment@acme.test',
        subject: 'Attachment review',
        body: 'The file is staged for review.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: ref,
        attachments: [
          {
            filename: 'brief.txt',
            contentType: 'text/plain',
            contentBase64: 'SGVsbG8=',
          },
        ],
      });
      const items = await service.listAgentInbox(WS, UC_UID);
      const mine = items.find((item) => item.subject === 'Attachment review');
      expect(mine?.attachments).toEqual([{ name: 'brief.txt', type: 'text/plain', size: 5 }]);
    });

    it('resolves a readable documentId into staged attachment bytes and metadata', async () => {
      // Stage the document under the mailbox compose actually selects for this
      // caller. findFirst over the workspace is not that mailbox once other
      // suites (e.g. #21's mailbox-scope fixtures) add mailboxes to WS.
      const probe = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'document@acme.test',
        subject: 'Stored document mailbox probe',
        body: 'probe',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: `document-probe-${Date.now()}`,
      });
      const probed = await prisma.emailMessage.findUniqueOrThrow({ where: { id: probe.id } });
      const mailbox = await prisma.mailboxAccount.findUniqueOrThrow({
        where: { id: probed.mailboxAccountId! },
      });
      const document = await prisma.outboundAttachment.create({
        data: {
          workspaceId: WS,
          mailboxId: mailbox.id,
          filename: 'stored.txt',
          mimeType: 'text/plain',
          size: 4,
          bytes: Buffer.from('docs'),
        },
      });
      const ref = `document-list-${Date.now()}`;
      const draft = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'document@acme.test',
        subject: 'Stored document review',
        body: 'The stored document is staged.',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: ref,
        attachments: [{ documentId: document.id }],
      });
      const staged = await prisma.emailMessage.findUniqueOrThrow({ where: { id: draft.id } });
      expect(staged.attachments).toEqual([
        expect.objectContaining({
          filename: 'stored.txt',
          name: 'stored.txt',
          content_type: 'text/plain',
          type: 'text/plain',
          content_base64: Buffer.from('docs').toString('base64'),
          size: 4,
        }),
      ]);
      const items = await service.listAgentInbox(WS, UC_UID);
      expect(items.find((item) => item.subject === 'Stored document review')?.attachments).toEqual([
        { name: 'stored.txt', type: 'text/plain', size: 4 },
      ]);
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
        send: async () => ({
          accepted: false,
          providerMessageId: null,
          threadId: null,
          reason: 'test',
        }),
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
      // External lane: the REAL move is the success signal — the overlay row is
      // never consulted by external reads, so it is honestly not view-effective.
      expect(out.viewEffective).toBe(false);
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

    it('external/unknown thread that could NOT be moved → moved:false, viewEffective:false, NO overlay row', async () => {
      // The live-fire bug: bulk TRASH on an external M365 thread wrote only the
      // overlay row (which external reads never consult) and reported success.
      // Now the failed move is reported honestly and the dead row is not written.
      const threadId = `ext-spam-broken-${Date.now()}`;
      const { service: svc } = externalService({
        spamThread: jest.fn().mockRejectedValue(new Error('provider 500')),
      });

      const out = await svc.applyThreadDisposition(WS, UC_UID, threadId, MessageDisposition.SPAM);

      expect(out.moved).toBe(false);
      expect(out.viewEffective).toBe(false);
      const row = await prisma.threadDisposition.findUnique({
        where: { workspaceId_threadId: { workspaceId: WS, threadId } },
      });
      expect(row).toBeNull();
    });

    it('sovereign degrade-clean: engine dormant but the SoR knows the thread → viewEffective:true + overlay written', async () => {
      // FakeStalwart.moveThreadToFolder is false (dormant move) and the provider
      // verbs are false too — but an emailMessage row carries this thread id, so
      // the overlay IS what sovereign readers see: overlay-only remains success.
      const threadId = `sov-dormant-${Date.now()}`;
      await prisma.emailMessage.create({
        data: {
          workspaceId: WS,
          threadId,
          toAddress: 'someone@acme.test',
          subject: 'known sovereign thread',
        },
      });
      const { service: svc } = externalService();

      const out = await svc.applyThreadDisposition(
        WS,
        UC_UID,
        threadId,
        MessageDisposition.ARCHIVE,
      );

      expect(out.moved).toBe(false);
      expect(out.viewEffective).toBe(true);
      const row = await prisma.threadDisposition.findUnique({
        where: { workspaceId_threadId: { workspaceId: WS, threadId } },
      });
      expect(row?.disposition).toBe(MessageDisposition.ARCHIVE);
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

  describe('compose_email — multi-recipient + reply_all', () => {
    it('returns the resolved to/cc/bcc on the compose wire shape', async () => {
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'a@acme.test',
        toAddresses: ['a@acme.test', 'b@acme.test'],
        cc: ['c@acme.test'],
        bcc: ['d@acme.test'],
        subject: 'Multi',
        body: 'Hi',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: `multi-${Date.now()}`,
      });
      expect(result.mode).toBe('draft');
      expect(result.status).toBe('pending_approval');
      expect(result.to).toEqual(['a@acme.test', 'b@acme.test']);
      expect(result.cc).toEqual(['c@acme.test']);
      expect(result.bcc).toEqual(['d@acme.test']);
      const items = await service.listAgentInbox(WS, UC_UID);
      const item = items.find((i) => i.message_id === result.id);
      expect(item?.to_addresses).toEqual(['a@acme.test', 'b@acme.test']);
      expect(item?.cc).toEqual(['c@acme.test']);
      expect(item?.bcc).toEqual(['d@acme.test']);
      expect(item?.summary).toMatch(/cc c@acme.test/);
      expect(item?.summary).toMatch(/bcc d@acme.test/);
    });

    it('rejects an address that appears in both To and Bcc', async () => {
      await expect(
        service.composeEmail(WS, UC_UID, {
          contactId: null,
          toAddress: 'a@acme.test',
          bcc: ['a@acme.test'],
          subject: 'Bad',
          body: 'Nope',
          mode: 'draft',
          externalSource: 'customer-ops',
          externalRef: `badbcc-${Date.now()}`,
        }),
      ).rejects.toThrow(/To\/Cc and Bcc/);
    });

    it('reply_all derives Outlook recipients from the latest thread message (sovereign)', async () => {
      const tid = `thread-ra-${Date.now()}`;
      stalwart.threadDetails = [
        {
          id: 'live-ra-1',
          threadId: tid,
          from: { address: 'alice@acme.test', name: 'Alice' },
          to: [
            { address: 'desk@magicunicorn.tech', name: null },
            { address: 'bob@acme.test', name: null },
          ],
          subject: 'Northbridge Tax',
          sentAt: '2026-09-03T00:00:00Z',
          preview: 'hello',
          direction: 'received',
          cc: [{ address: 'jordan@acme.test', name: null }],
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
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: '',
        replyAll: true,
        inReplyToThreadId: tid,
        subject: 'Re: Northbridge Tax',
        body: 'Thanks',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: `ra-${Date.now()}`,
      });
      expect(result.to).toEqual(['alice@acme.test']);
      expect(result.cc).toEqual(['bob@acme.test', 'jordan@acme.test']);
      expect(result.bcc).toEqual([]);
      expect(result.thread_id).toBe(tid);
    });

    it('L1 autonomy downgrade to draft still preserves the full recipient set', async () => {
      const key = `l1-multi-${Date.now()}`;
      await prisma.agent.create({
        data: {
          workspaceId: WS,
          key,
          displayName: 'L1 Multi',
          autonomyLevel: AgentAutonomyLevel.L1_APPROVE_TO_SEND,
        },
      });
      const result = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'a@acme.test',
        toAddresses: ['a@acme.test', 'b@acme.test'],
        cc: ['c@acme.test'],
        bcc: ['d@acme.test'],
        subject: 'Held',
        body: 'Please hold',
        mode: 'send',
        externalSource: key,
        externalRef: `held-${Date.now()}`,
        draftedBy: key,
      });
      expect(result.mode).toBe('draft');
      expect(result.status).toBe('pending_approval');
      expect(result.to).toEqual(['a@acme.test', 'b@acme.test']);
      expect(result.cc).toEqual(['c@acme.test']);
      expect(result.bcc).toEqual(['d@acme.test']);
      expect(stalwart.sendCalls).toHaveLength(0);
    });

    it('APPROVE of a multi-recipient draft still sends the staged To/Cc/Bcc', async () => {
      const ref = `appr-multi-${Date.now()}`;
      const draft = await service.composeEmail(WS, UC_UID, {
        contactId: null,
        toAddress: 'a@acme.test',
        toAddresses: ['a@acme.test', 'b@acme.test'],
        cc: ['c@acme.test'],
        bcc: ['d@acme.test'],
        subject: 'Approve me',
        body: 'Go',
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      const item = await prisma.agentInboxItem.findUniqueOrThrow({
        where: { messageId: draft.id },
      });
      await service.approveAgentInboxItem(WS, 'uc-approver', item.id, 'ok');
      expect(stalwart.sendCalls).toHaveLength(1);
      expect(stalwart.sendCalls[0].req.toAddresses).toEqual(['a@acme.test', 'b@acme.test']);
      expect(stalwart.sendCalls[0].req.cc).toEqual(['c@acme.test']);
      expect(stalwart.sendCalls[0].req.bcc).toEqual(['d@acme.test']);
    });
  });
});
