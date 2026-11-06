import { EmailService } from './email.service';

describe('EmailService.resolveMailboxIdForCaller', () => {
  const workspaceId = 'workspace-1';
  const userKey = 'member-1';

  function makeService(addressMailbox: Record<string, unknown> | null) {
    const tx = {
      membership: {
        findUnique: jest.fn().mockResolvedValue({
          role: 'OWNER',
          status: 'ACTIVE',
          mailboxScope: 'ALL',
          userKey,
        }),
      },
      mailboxAccount: {
        findMany: jest.fn().mockResolvedValue([{ id: 'mailbox-1' }]),
        findFirst: jest.fn().mockResolvedValue(addressMailbox),
      },
    };
    const prisma = {
      withWorkspace: jest.fn((_workspace: string, _uid: string | null, fn: (value: unknown) => unknown) => fn(tx)),
    } as unknown as ConstructorParameters<typeof EmailService>[0];
    return { service: new EmailService(prisma, {} as never, {} as never, {} as never), tx };
  }

  it('resolves a mailbox address within the caller workspace', async () => {
    const { service, tx } = makeService({
      id: 'mailbox-1',
      emailAddress: 'Desk@Example.test',
      ownerKind: 'SHARED',
      ownerKey: null,
    });

    await expect(
      service.resolveMailboxIdForCaller(workspaceId, userKey, undefined, 'desk@example.test'),
    ).resolves.toBe('mailbox-1');
    expect(tx.mailboxAccount.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId,
        emailAddress: { equals: 'desk@example.test', mode: 'insensitive' },
      },
    });
  });

  it('returns the scoped 404 code when an address is unknown', async () => {
    const { service } = makeService(null);

    await expect(
      service.resolveMailboxIdForCaller(workspaceId, userKey, undefined, 'missing@example.test'),
    ).rejects.toEqual(expect.objectContaining({ message: 'mailbox_not_found', status: 404 }));
  });
});
