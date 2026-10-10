import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import {
  MailboxOwnerKind,
  MailboxScope,
  MembershipStatus,
  WorkspaceRole,
} from '@prisma/client';
import { TEST_DATABASE_URL } from '../../test/test-db';
import { PrismaService } from '../prisma/prisma.service';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { EmailService } from './email.service';

/**
 * HTTP-plane authorization contract exercised at the EmailService seam used by
 * both REST and MCP: an OWNED member gets only their human mailbox, while the
 * legacy ALL default and OWNER role remain workspace-wide.
 */
describe('EmailService member mailbox scope (integration)', () => {
  const dbUrl = TEST_DATABASE_URL;
  const ownedMember = 'scope-owned-member';
  const allMember = 'scope-all-member';
  const owner = 'scope-owner';
  const workspaceId = randomUUID();
  let prisma: PrismaService;
  let service: EmailService;
  let ownedMailboxId: string;
  let otherMailboxId: string;

  const provider = {
    handles: () => true,
    listInbox: async (mailbox: { id: string }) => ({
      threads: [
        {
          id: `thread-${mailbox.id}`,
          subject: mailbox.id,
          message_count: 1,
          unread: true,
          last_message_at: '2026-10-10T12:00:00.000Z',
          last_snippet: 'scope test',
          participants: [],
        },
      ],
      nextPageToken: null,
      hasMore: false,
      searchSupported: true,
      reason: null,
    }),
    listThreadMessages: async (mailbox: { id: string }) => [
      {
        id: `message-${mailbox.id}`,
        thread_id: `thread-${mailbox.id}`,
        from: null,
        to: [],
        subject: mailbox.id,
        sent_at: null,
        preview: 'scope test',
        direction: 'inbound',
      },
    ],
    getInboxCounts: async (mailbox: { id: string }) => ({
      inboxUnread: mailbox.id === ownedMailboxId ? 1 : 2,
      inboxTotal: mailbox.id === ownedMailboxId ? 3 : 4,
    }),
    send: async () => ({
      accepted: true,
      providerMessageId: 'scope-provider-message',
      threadId: 'scope-send-thread',
      lane: 'gmail',
      reason: null,
    }),
  } as unknown as MailProviderPort;

  beforeAll(async () => {
    process.env.DATABASE_URL = dbUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.workspace.create({
      data: { id: workspaceId, slug: `scope-${workspaceId.slice(0, 8)}`, displayName: 'Mailbox scope test' },
    });
    await prisma.membership.createMany({
      data: [
        {
          userKey: ownedMember,
          workspaceId,
          role: WorkspaceRole.MEMBER,
          status: MembershipStatus.ACTIVE,
          mailboxScope: MailboxScope.OWNED,
        },
        {
          userKey: allMember,
          workspaceId,
          role: WorkspaceRole.MEMBER,
          status: MembershipStatus.ACTIVE,
          mailboxScope: MailboxScope.ALL,
        },
        {
          userKey: owner,
          workspaceId,
          role: WorkspaceRole.OWNER,
          status: MembershipStatus.ACTIVE,
          mailboxScope: MailboxScope.OWNED,
        },
      ],
    });
    const owned = await prisma.mailboxAccount.create({
      data: {
        workspaceId,
        emailAddress: 'owned-scope@example.test',
        provider: 'gmail',
        kind: 'gmail',
        ownerKind: MailboxOwnerKind.HUMAN,
        ownerKey: ownedMember,
        isDefault: true,
      },
    });
    const other = await prisma.mailboxAccount.create({
      data: {
        workspaceId,
        emailAddress: 'other-scope@example.test',
        provider: 'gmail',
        kind: 'gmail',
        ownerKind: MailboxOwnerKind.HUMAN,
        ownerKey: 'another-member',
      },
    });
    ownedMailboxId = owned.id;
    otherMailboxId = other.id;
  });

  beforeEach(() => {
    const connectedAccounts = {} as ConnectedAccountsService;
    service = new EmailService(prisma, {} as never, connectedAccounts, provider);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.agentInboxItem.deleteMany({ where: { workspaceId } });
    await prisma.agentActionEvent.deleteMany({ where: { workspaceId } });
    await prisma.emailMessage.deleteMany({ where: { workspaceId } });
    await prisma.mailContact.deleteMany({ where: { workspaceId } });
    await prisma.mailboxAccount.deleteMany({ where: { workspaceId } });
    await prisma.membership.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
    await prisma.$disconnect();
  });

  it('OWNED sees and composes only from its HUMAN mailbox, with 404-style denial', async () => {
    const ownThreads = await service.listMailboxInbox(workspaceId, ownedMember, ownedMailboxId);
    expect(ownThreads).toHaveLength(1);

    await expect(service.listMailboxInbox(workspaceId, ownedMember, otherMailboxId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.listThreadMessages(workspaceId, ownedMember, 'foreign-thread', otherMailboxId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.downloadAttachment(workspaceId, ownedMember, otherMailboxId, 'foreign-blob'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.composeEmail(workspaceId, ownedMember, {
        contactId: null,
        toAddress: 'recipient@example.test',
        subject: 'foreign compose',
        body: 'must not send',
        mode: 'send',
        externalSource: 'email-ops-client',
        externalRef: `foreign-${randomUUID()}`,
        fromMailboxAccountId: otherMailboxId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const sent = await service.composeEmail(workspaceId, ownedMember, {
      contactId: null,
      toAddress: 'recipient@example.test',
      subject: 'owned compose',
      body: 'allowed',
      mode: 'send',
      externalSource: 'email-ops-client',
      externalRef: `owned-${randomUUID()}`,
      fromMailboxAccountId: ownedMailboxId,
    });
    expect(sent.from_address).toBe('owned-scope@example.test');
  });

  it('aggregate/counts omit foreign mailboxes while ALL and OWNER remain workspace-wide', async () => {
    const ownedAggregate = await service.listAggregateInbox(workspaceId, ownedMember, 'inbox', 50);
    expect(ownedAggregate.map((thread) => thread.mailbox_id)).toEqual([ownedMailboxId]);
    const ownedCounts = await service.getWorkspaceMailCounts(workspaceId, ownedMember);
    expect(ownedCounts.map((count) => count.mailbox_id)).toEqual([ownedMailboxId]);

    const allAggregate = await service.listAggregateInbox(workspaceId, allMember, 'inbox', 50);
    expect(new Set(allAggregate.map((thread) => thread.mailbox_id))).toEqual(
      new Set([ownedMailboxId, otherMailboxId]),
    );
    const ownerCounts = await service.getWorkspaceMailCounts(workspaceId, owner);
    expect(new Set(ownerCounts.map((count) => count.mailbox_id))).toEqual(
      new Set([ownedMailboxId, otherMailboxId]),
    );
  });

  it('hides agent-inbox drafts staged from another mailbox from OWNED list/approve/reject', async () => {
    await service.composeEmail(workspaceId, allMember, {
      contactId: null,
      toAddress: 'recipient@example.test',
      subject: 'foreign draft',
      body: 'must remain hidden',
      mode: 'draft',
      externalSource: 'scope-agent-test',
      externalRef: `draft-${randomUUID()}`,
      fromMailboxAccountId: otherMailboxId,
    });
    const item = await prisma.agentInboxItem.findFirstOrThrow({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    expect(
      (await service.listAgentInbox(workspaceId, ownedMember)).some((entry) => entry.id === item.id),
    ).toBe(false);
    await expect(service.peekAgentInboxKind(workspaceId, ownedMember, item.id)).resolves.toBeNull();
    await expect(service.approveAgentInboxItem(workspaceId, ownedMember, item.id)).resolves.toBeNull();
    await expect(service.rejectAgentInboxItem(workspaceId, ownedMember, item.id)).resolves.toBeNull();

    const unchanged = await prisma.agentInboxItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.state).toBe('PENDING');
  });
});
