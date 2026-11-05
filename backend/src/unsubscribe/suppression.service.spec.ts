import { NotFoundException } from '@nestjs/common';
import { SuppressedRecipientReason } from '@prisma/client';
import { SuppressionService } from './suppression.service';

describe('SuppressionService', () => {
  const workspaceId = 'workspace-fictional-555';
  const messageId = 'message-fictional-555';
  const kitId = 'kit-fictional-555';
  let config: { get: jest.Mock };
  let tx: any;
  let prisma: any;
  let systemToken: any;
  let service: SuppressionService;

  beforeEach(() => {
    systemToken = {
      id: 'token-fictional-555',
      workspaceId,
      email: 'reader@example.test',
      kitId,
      messageId,
      usedAt: null,
    };
    const suppressionRow = {
      id: 'suppression-fictional-555',
      workspaceId,
      email: 'reader@example.test',
      reason: SuppressedRecipientReason.MANUAL,
      source: 'user:fictional-reviewer-555',
      note: 'fictional test note',
      createdAt: new Date('2026-11-05T03:00:00.000Z'),
    };
    tx = {
      unsubscribeToken: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockImplementation(() => {
          if (systemToken.usedAt) return { count: 0 };
          systemToken.usedAt = new Date('2026-11-05T03:01:00.000Z');
          return { count: 1 };
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      suppressedRecipient: {
        upsert: jest
          .fn()
          .mockImplementation(({ create, update }: any) =>
            Promise.resolve({ ...suppressionRow, ...create, ...update }),
          ),
        findMany: jest.fn().mockResolvedValue([suppressionRow]),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      emailMessage: { findFirst: jest.fn().mockResolvedValue({ id: messageId }) },
      emailEngagementEvent: { upsert: jest.fn().mockResolvedValue({}) },
    };
    config = {
      get: jest.fn((key: string, fallback?: string) =>
        key === 'FRONTEND_URL' ? 'https://email.example.test' : fallback,
      ),
    };
    prisma = {
      systemClient: {
        unsubscribeToken: {
          findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...systemToken })),
        },
      },
      withWorkspace: jest.fn(
        (_workspace: string, _uid: string | null, fn: (value: any) => unknown) =>
          Promise.resolve(fn(tx)),
      ),
    };
    service = new SuppressionService(prisma, config as any);
  });

  it('builds RFC 8058 headers without changing body bytes or storing the raw token', async () => {
    const body = Buffer.from('Fictional campaign body — reply no to opt out.');
    const before = Buffer.from(body);
    const headers = await service.prepareKitHeaders(
      tx,
      workspaceId,
      'Reader <READER@example.test>',
      kitId,
      messageId,
      'sender@example.test',
    );

    expect(body.equals(before)).toBe(true);
    expect(headers[0]).toMatchObject({ name: 'List-Unsubscribe' });
    expect(headers[0].value).toMatch(
      /^<https:\/\/email\.example\.test\/api\/v1\/u\/[A-Za-z0-9_-]+>, <mailto:sender@example\.test\?subject=unsubscribe>$/,
    );
    expect(headers[1]).toEqual({
      name: 'List-Unsubscribe-Post',
      value: 'List-Unsubscribe=One-Click',
    });
    const tokenHash = tx.unsubscribeToken.create.mock.calls[0][0].data.tokenHash as string;
    const rawToken = headers[0].value.match(/\/u\/([^>]+)>/)![1];
    expect(tokenHash).not.toBe(rawToken);
    expect(tx.unsubscribeToken.create.mock.calls[0][0].data.email).toBe('reader@example.test');
  });

  it('one-click suppresses and records one unsubscribed event, then rejects repeats generically', async () => {
    const rawToken = 'fictional-token-555';
    await service.consumeOneClick(rawToken);

    expect(tx.unsubscribeToken.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.suppressedRecipient.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          email: 'reader@example.test',
          reason: SuppressedRecipientReason.UNSUBSCRIBED,
          source: kitId,
        }),
      }),
    );
    expect(tx.emailEngagementEvent.upsert).toHaveBeenCalledTimes(1);
    expect(tx.emailEngagementEvent.upsert.mock.calls[0][0].create.normalizedKind).toBe(
      'UNSUBSCRIBED',
    );

    await expect(service.consumeOneClick(rawToken)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.suppressedRecipient.upsert).toHaveBeenCalledTimes(1);
    expect(tx.emailEngagementEvent.upsert).toHaveBeenCalledTimes(1);

    prisma.systemClient.unsubscribeToken.findUnique.mockResolvedValueOnce(null);
    await expect(service.consumeOneClick('bad-fictional-token')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('supports fictional manual suppression and human removal through the shared service', async () => {
    const created = await service.suppressManually(
      workspaceId,
      'fictional-reviewer-555',
      'Manual <manual@example.test>',
      'fictional test note',
    );
    expect(created.email).toBe('manual@example.test');
    expect(tx.suppressedRecipient.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          email: 'manual@example.test',
          reason: SuppressedRecipientReason.MANUAL,
          source: 'user:fictional-reviewer-555',
        }),
      }),
    );
    await expect(
      service.remove(workspaceId, 'fictional-reviewer-555', 'suppression-555'),
    ).resolves.toBe(true);
  });
});
