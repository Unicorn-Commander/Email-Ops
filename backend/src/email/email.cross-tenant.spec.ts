import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartSendResult } from '../stalwart/stalwart.types';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { EmailService } from './email.service';

/** A sovereign-only fake provider: handles() false → the Stalwart path is used. */
const fakeMailProvider = {
  handles: () => false,
  listInbox: async () => [],
  listThreadMessages: async () => [],
  send: async () => ({ accepted: false, providerMessageId: null, threadId: null, reason: 'test' }),
} as unknown as MailProviderPort;

/**
 * Regression locks for the two most severe findings of the command-center
 * adversarial review (integration, real verify DB, two workspaces):
 *   - cross-tenant approve/reject: a caller scoped to workspace A must NOT be able
 *     to act on an agent-inbox item that lives in workspace B (it would otherwise
 *     SEND B's drafted mail + poison B's audit trail). RLS is inert under the
 *     owner role today, so the explicit workspaceId fence is the real guard.
 *   - send-identity spoofing: composeEmail must refuse to send AS a HUMAN mailbox
 *     the caller doesn't own.
 */
const DB_URL = 'postgresql://postgres:REMOVED@127.0.0.1:55444/emailops?schema=public';

class FakeStalwart extends StalwartPort {
  isConfigured(): boolean {
    return true;
  }
  async listThreads() {
    return [];
  }
  async listMessages() {
    return [];
  }
  async send(): Promise<StalwartSendResult> {
    return { accepted: true, providerMessageId: 'x', threadId: 't1', lane: 'stalwart', reason: null };
  }
}

describe('EmailService — cross-tenant + send-identity guards (integration)', () => {
  let prisma: PrismaService;
  let service: EmailService;
  const A = '0190a000-7e57-7000-8000-00000000ac01';
  const B = '0190a000-7e57-7000-8000-00000000ac02';

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, slug] of [
      [A, 'ws-xt-a'],
      [B, 'ws-xt-b'],
    ]) {
      await prisma.workspace.upsert({
        where: { id },
        update: {},
        create: { id, slug, displayName: slug },
      });
    }
    const connectedAccounts = {
      approveCleanupBatch: jest.fn(),
      undoBatch: jest.fn(),
    } as unknown as ConnectedAccountsService;
    service = new EmailService(prisma, new FakeStalwart(), connectedAccounts, fakeMailProvider);
  });

  afterAll(async () => {
    if (prisma) {
      for (const id of [A, B]) {
        await prisma.agentInboxItem.deleteMany({ where: { workspaceId: id } });
        await prisma.emailMessage.deleteMany({ where: { workspaceId: id } });
        await prisma.mailboxAccount.deleteMany({ where: { workspaceId: id } });
        await prisma.workspace.deleteMany({ where: { id } });
      }
      await prisma.$disconnect();
    }
  });

  it('a caller in workspace A cannot approve or reject an inbox item that lives in B', async () => {
    await prisma.mailboxAccount.create({
      data: { workspaceId: B, emailAddress: 'deskb@xt.test', isDefault: true },
    });
    await service.composeEmail(B, 'uc-b', {
      contactId: null,
      toAddress: 'x@y.test',
      subject: 's',
      body: 'b',
      mode: 'draft',
      externalSource: 'test',
      externalRef: `xt-${Date.now()}`,
    });
    const item = await prisma.agentInboxItem.findFirst({ where: { workspaceId: B } });
    expect(item).toBeTruthy();

    // The fix: the lookup is workspace-scoped → a foreign item resolves to null (404).
    expect(await service.approveAgentInboxItem(A, 'uc-a', item!.id)).toBeNull();
    expect(await service.rejectAgentInboxItem(A, 'uc-a', item!.id)).toBeNull();

    // B's item is untouched — still PENDING, never sent.
    const after = await prisma.agentInboxItem.findFirst({ where: { id: item!.id } });
    expect(after!.state).toBe('PENDING');
  });

  it('refuses to send AS a HUMAN mailbox the caller does not own (no identity spoofing)', async () => {
    const mb = await prisma.mailboxAccount.create({
      data: {
        workspaceId: A,
        emailAddress: 'ceo@xt.test',
        ownerKind: 'HUMAN',
        ownerKey: 'someone-else-uid',
        kind: 'human',
      },
    });
    await expect(
      service.composeEmail(A, 'uc-attacker', {
        contactId: null,
        toAddress: 'x@y.test',
        subject: 's',
        body: 'b',
        mode: 'send',
        externalSource: 'test',
        externalRef: `spoof-${Date.now()}`,
        fromMailboxAccountId: mb.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
