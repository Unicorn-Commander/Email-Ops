import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TEST_DATABASE_URL } from '../../test/test-db';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartDraftRequest, StalwartSendResult, StalwartVacationState } from '../stalwart/stalwart.types';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { EmailService } from './email.service';

/**
 * Intra-tenant per-USER mailbox fence (P0 from the unified-inbox adversarial
 * audit). A HUMAN external mailbox (gmail/microsoft) is a person's PRIVATE
 * account: reads + sends run on the OWNER's KC-broker token. The workspaceId
 * predicate isolates tenants but NOT co-members — so without an owner check a
 * co-member could pass another member's mailboxId and the server would read /
 * send as them. These integration locks prove: the owner sees their own data,
 * a co-member sees nothing (read) and is refused (approve→send).
 *
 * The fake provider HANDLES gmail and returns a sentinel, so a regression that
 * dropped the fence would leak it (and these tests would fail loudly).
 */
// Integration DB URL (verify Postgres). Overridable via TEST_DATABASE_URL (CI service container);
// defaults to the historical verify DB so local runs are unchanged.
const DB_URL = TEST_DATABASE_URL;

const SENTINEL = {
  id: 'g-t1',
  subject: 'Owner private',
  message_count: 1,
  unread: true,
  last_message_at: null,
  last_snippet: 'secret',
  participants: [],
};

const externalProvider = {
  handles: (mb: { provider?: string }) => mb.provider === 'gmail' || mb.provider === 'microsoft',
  listInbox: async () => [SENTINEL],
  listThreadMessages: async () => [
    {
      id: 'g-m1',
      thread_id: 'g-t1',
      from: null,
      to: [],
      subject: 'Owner private',
      sent_at: null,
      preview: 'secret',
      direction: 'inbound',
    },
  ],
  send: async () => ({ accepted: true, providerMessageId: 'pm-1', threadId: 'g-t1', reason: null }),
} as unknown as MailProviderPort;

class FakeStalwart extends StalwartPort {
  // Wave-5 port surface — degrade-clean no-ops (these RLS/webhook specs never exercise them).
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
  async emptyFolder(): Promise<number | null> {
    return null;
  }
  async getMailboxCounts(): Promise<null> {
    return null;
  }
  async downloadBlob(): Promise<null> {
    return null;
  }
  async getMessageHeaders(): Promise<null> {
    return null;
  }
  async uploadBlob(): Promise<null> {
    return null;
  }

  async pollInbound(): Promise<null> {
    return null;
  }
  async moveThreadToMailbox(): Promise<boolean> {
    return false;
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
  isConfigured(): boolean {
    return true;
  }
  async listThreads() {
    return [];
  }
  async listMessages() {
    return [];
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
  async send(): Promise<StalwartSendResult> {
    return { accepted: true, providerMessageId: 'x', threadId: 't1', lane: 'stalwart', reason: null };
  }
}

describe('EmailService — intra-tenant per-user mailbox fence (integration)', () => {
  let prisma: PrismaService;
  let service: EmailService;
  const WS = '0190a000-7e57-7000-8000-00000000af01';
  const OWNER = 'owner-uid';
  const INTRUDER = 'intruder-uid';
  let mbId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.workspace.upsert({
      where: { id: WS },
      update: {},
      create: { id: WS, slug: 'ws-it-af', displayName: 'ws-it-af' },
    });
    const mb = await prisma.mailboxAccount.create({
      data: {
        workspaceId: WS,
        emailAddress: 'owner@gmail.test',
        provider: 'gmail',
        ownerKind: 'HUMAN',
        ownerKey: OWNER,
        kind: 'gmail',
      },
    });
    mbId = mb.id;
    const connectedAccounts = {
      approveCleanupBatch: jest.fn(),
      undoBatch: jest.fn(),
    } as unknown as ConnectedAccountsService;
    service = new EmailService(prisma, new FakeStalwart(), connectedAccounts, externalProvider);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.agentInboxItem.deleteMany({ where: { workspaceId: WS } });
      await prisma.agentActionEvent.deleteMany({ where: { workspaceId: WS } });
      await prisma.emailMessage.deleteMany({ where: { workspaceId: WS } });
      await prisma.mailboxAccount.deleteMany({ where: { workspaceId: WS } });
      await prisma.workspace.deleteMany({ where: { id: WS } });
      await prisma.$disconnect();
    }
  });

  it('inbox read: the owner sees their external inbox; a co-member gets nothing', async () => {
    const ownerView = await service.listMailboxInbox(WS, OWNER, mbId);
    expect(ownerView.map((t) => t.id)).toContain('g-t1');

    const intruderView = await service.listMailboxInbox(WS, INTRUDER, mbId);
    expect(intruderView).toEqual([]);
  });

  it('thread read: the owner reads the external thread; a co-member gets nothing', async () => {
    const ownerMsgs = await service.listThreadMessages(WS, OWNER, 'g-t1', mbId);
    expect(ownerMsgs.map((m) => m.id)).toContain('g-m1');

    const intruderMsgs = await service.listThreadMessages(WS, INTRUDER, 'g-t1', mbId);
    expect(intruderMsgs).toEqual([]);
  });

  it('approve→send: only the owner may approve a send from their external mailbox', async () => {
    // The owner stages a draft FROM their own external mailbox (allowed by the
    // existing compose send-as check).
    await service.composeEmail(WS, OWNER, {
      contactId: null,
      toAddress: 'x@y.test',
      subject: 's',
      body: 'b',
      mode: 'draft',
      externalSource: 'test',
      externalRef: `it-${Date.now()}`,
      fromMailboxAccountId: mbId,
    });
    const item = await prisma.agentInboxItem.findFirst({
      where: { workspaceId: WS },
      orderBy: { createdAt: 'desc' },
    });
    expect(item).toBeTruthy();

    // A co-member approving would push mail out of the owner's personal Gmail — refused.
    await expect(service.approveAgentInboxItem(WS, INTRUDER, item!.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const stillPending = await prisma.agentInboxItem.findFirst({ where: { id: item!.id } });
    expect(stillPending!.state).toBe('PENDING');

    // The owner can approve → it sends through the external provider.
    const res = await service.approveAgentInboxItem(WS, OWNER, item!.id);
    expect(res).toBeTruthy();
    expect(res!.message?.status).toBe('sent');
  });
});
