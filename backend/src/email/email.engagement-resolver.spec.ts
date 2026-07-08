import { EmailMessageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';

describe('EmailService engagement resolver', () => {
  it('resolves providerMessageId through the BYPASSRLS system client before the scoped write', async () => {
    const workspaceId = 'ws-email-system';
    const tx = {
      emailEngagementEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      },
      emailMessage: {
        update: jest.fn().mockResolvedValue({ status: EmailMessageStatus.DELIVERED }),
      },
    };
    const systemClient = {
      emailMessage: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'msg-system-resolved',
          workspaceId,
          status: EmailMessageStatus.SENT,
        }),
      },
    };
    const runtimeEmailMessage = {
      findFirst: jest.fn(async () => {
        throw new Error('runtime client must not resolve workspace-agnostic webhooks');
      }),
    };
    const prisma = {
      systemClient,
      emailMessage: runtimeEmailMessage,
      withWorkspace: jest.fn((_workspaceId: string, _ucUid: string | null, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const service = new EmailService(prisma, {} as any, { approveCleanupBatch: jest.fn(), undoBatch: jest.fn() } as any, {
      handles: () => false,
      listInbox: async () => [],
      listThreadMessages: async () => [],
      send: async () => ({ accepted: false, providerMessageId: null, threadId: null, reason: 'test' }),
    } as any);

    const res = await service.recordEngagementEvent({
      provider: 'postmark',
      providerMessageId: 'pmid-system',
      providerEventId: 'evt-system',
      recordType: 'Delivery',
      normalizedKind: null,
      statusTarget: EmailMessageStatus.DELIVERED,
      occurredAt: new Date('2026-06-03T16:00:00Z'),
      raw: { RecordType: 'Delivery', MessageID: 'pmid-system' },
    });

    expect(res).toMatchObject({ outcome: 'recorded', workspaceId, emailMessageId: 'msg-system-resolved' });
    expect(systemClient.emailMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerMessageId: 'pmid-system' },
      select: { id: true, workspaceId: true, status: true },
    }));
    expect(runtimeEmailMessage.findFirst).not.toHaveBeenCalled();
    expect(prisma.withWorkspace).toHaveBeenCalledWith(workspaceId, null, expect.any(Function));
  });
});
