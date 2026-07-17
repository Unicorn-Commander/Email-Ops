import { ConflictException, ForbiddenException } from '@nestjs/common';
import { MailDomain, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailDomainService } from './mail-domain.service';

describe('MailDomainService', () => {
  const rows: MailDomain[] = [];
  let sequence = 0;

  const tx = {
    mailDomain: {
      create: jest.fn(async ({ data }: { data: { workspaceId: string; domain: string } }) => {
        if (rows.some((row) => row.domain === data.domain)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['domain'] },
          });
        }
        const now = new Date('2026-07-17T12:00:00.000Z');
        const row: MailDomain = {
          id: `domain-${++sequence}`,
          workspaceId: data.workspaceId,
          domain: data.domain,
          verified: false,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async ({ where }: { where: { workspaceId: string; domain: string } }) =>
          rows.find(
            (row) => row.workspaceId === where.workspaceId && row.domain === where.domain,
          ) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { workspaceId: string } }) =>
        rows
          .filter((row) => row.workspaceId === where.workspaceId)
          .sort((a, b) => a.domain.localeCompare(b.domain)),
      ),
    },
  };

  const prisma = {
    withWorkspace: jest.fn(
      async (_workspaceId: string, _ucUid: string | null, fn: (client: typeof tx) => unknown) =>
        fn(tx),
    ),
    systemClient: {
      mailDomain: {
        findFirst: jest.fn(() => {
          throw new Error('MailDomainService must not use systemClient');
        }),
      },
    },
  } as unknown as PrismaService;

  const service = new MailDomainService(prisma);

  beforeEach(() => {
    rows.splice(0, rows.length);
    sequence = 0;
    jest.clearAllMocks();
  });

  it('binds a canonical domain idempotently inside the workspace transaction', async () => {
    const first = await service.bindDomain('ws-a', 'uc-a', ' Example.TEST. ');
    const second = await service.bindDomain('ws-a', 'uc-a', 'example.test');

    expect(first.domain).toBe('example.test');
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(prisma.withWorkspace).toHaveBeenCalledWith('ws-a', 'uc-a', expect.any(Function));
  });

  it('returns a clear conflict when another workspace already claimed the domain', async () => {
    await service.bindDomain('ws-a', 'uc-a', 'shared.test');

    await expect(service.bindDomain('ws-b', 'uc-b', 'shared.test')).rejects.toThrow(
      new ConflictException('Mail domain "shared.test" is already bound to another workspace.'),
    );
  });

  it('asserts ownership and forbids a workspace that cannot see the binding', async () => {
    await service.bindDomain('ws-a', 'uc-a', 'owned.test');

    await expect(
      service.assertWorkspaceOwnsDomain('ws-a', 'uc-a', 'owned.test'),
    ).resolves.toMatchObject({ workspaceId: 'ws-a', domain: 'owned.test' });
    await expect(service.assertWorkspaceOwnsDomain('ws-b', 'uc-b', 'owned.test')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('lists only rows carrying the requested workspace id', async () => {
    await service.bindDomain('ws-a', 'uc-a', 'a.test');
    await service.bindDomain('ws-b', 'uc-b', 'b.test');

    await expect(service.listDomains('ws-a', 'uc-a')).resolves.toEqual([
      expect.objectContaining({ workspaceId: 'ws-a', domain: 'a.test' }),
    ]);
    await expect(service.listDomains('ws-b', 'uc-b')).resolves.toEqual([
      expect.objectContaining({ workspaceId: 'ws-b', domain: 'b.test' }),
    ]);
  });

  it('extracts and canonicalizes the domain from a mailbox address', () => {
    expect(service.domainOf('User@EXAMPLE.TEST.')).toBe('example.test');
  });
});
