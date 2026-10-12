import { ConflictException, ForbiddenException } from '@nestjs/common';
import { MailDomain, Prisma, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailDomainService } from './mail-domain.service';

describe('MailDomainService', () => {
  const rows: MailDomain[] = [];
  const auditEvents: unknown[] = [];
  let sequence = 0;
  const resolver = { resolveTxt: jest.fn<Promise<string[][]>, [string]>() };

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
          verificationToken: null,
          verificationRequestedAt: null,
          verifiedAt: null,
          lastVerificationCheckAt: null,
          lastVerificationError: null,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async ({ where }: { where: { workspaceId: string; domain?: string; id?: string } }) =>
          rows.find(
            (row) =>
              row.workspaceId === where.workspaceId &&
              (where.domain === undefined || row.domain === where.domain) &&
              (where.id === undefined || row.id === where.id),
          ) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { workspaceId: string } }) =>
        rows
          .filter((row) => row.workspaceId === where.workspaceId)
          .sort((a, b) => a.domain.localeCompare(b.domain)),
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<MailDomain> }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('row not found');
        Object.assign(row, data);
        return row;
      }),
    },
    agentActionEvent: {
      create: jest.fn(async ({ data }: { data: unknown }) => {
        auditEvents.push(data);
        return data;
      }),
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
        findMany: jest.fn(async () =>
          rows
            .filter((row) => row.verified && row.verificationToken)
            .map((row) => ({ id: row.id, workspaceId: row.workspaceId })),
        ),
      },
    },
  } as unknown as PrismaService;

  let service: MailDomainService;

  beforeEach(() => {
    rows.splice(0, rows.length);
    auditEvents.splice(0, auditEvents.length);
    sequence = 0;
    jest.clearAllMocks();
    resolver.resolveTxt.mockReset();
    service = new MailDomainService(prisma, resolver);
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

  it('generates a 32-byte TXT challenge and audits the request', async () => {
    const row = await service.bindDomain('ws-a', 'uc-a', 'example.test');

    await expect(
      service.requestVerification('ws-a', 'uc-a', WorkspaceRole.ADMIN, row.id),
    ).resolves.toMatchObject({
      recordName: '_emailops-verify.example.test',
      recordType: 'TXT',
      recordValue: expect.stringMatching(/^emailops-verify=[0-9a-f]{64}$/),
    });
    expect(rows[0].verificationToken).toHaveLength(64);
    expect(rows[0].verificationRequestedAt).toBeInstanceOf(Date);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-a',
        kind: 'MAIL_DOMAIN_VERIFICATION_REQUESTED',
        actorUcUid: 'uc-a',
      }),
    ]);
  });

  it('rejects MEMBER verification mutations with 403', async () => {
    const row = await service.bindDomain('ws-a', 'uc-a', 'member.test');

    await expect(
      service.requestVerification('ws-a', 'uc-a', WorkspaceRole.MEMBER, row.id),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.checkVerification('ws-a', 'uc-a', WorkspaceRole.MEMBER, row.id),
    ).rejects.toThrow(ForbiddenException);
  });

  it.each([
    ['a matching TXT record', [['emailops-verify=token']] as string[][], true, null],
    ['a mismatching TXT record', [['emailops-verify=other']] as string[][], false, /did not contain/],
    ['no TXT record', [] as string[][], false, /did not contain/],
  ])('%s updates verification state', async (_label, records, verified, error) => {
    const row = await service.bindDomain('ws-a', 'uc-a', 'dns.test');
    await service.requestVerification('ws-a', 'uc-a', WorkspaceRole.OWNER, row.id);
    resolver.resolveTxt.mockResolvedValue(
      records.map((record) =>
        record.map((part) =>
          part === 'emailops-verify=token'
            ? `emailops-verify=${rows[0].verificationToken}`
            : part,
        ),
      ),
    );

    const result = await service.checkVerification(
      'ws-a',
      'uc-a',
      WorkspaceRole.ADMIN,
      row.id,
      new Date('2026-10-12T01:00:00.000Z'),
    );

    expect(resolver.resolveTxt).toHaveBeenCalledWith('_emailops-verify.dns.test');
    expect(result.verified).toBe(verified);
    if (error) expect(result.lastVerificationError).toMatch(error);
    else expect(result.lastVerificationError).toBeNull();
    expect(result.lastVerificationCheckAt).toBe('2026-10-12T01:00:00.000Z');
    expect(auditEvents.at(-1)).toEqual(
      expect.objectContaining({
        kind: verified ? 'MAIL_DOMAIN_VERIFIED' : 'MAIL_DOMAIN_VERIFICATION_FAILED',
      }),
    );
  });

  it('records a DNS error and preserves an existing verified state', async () => {
    const row = await service.bindDomain('ws-a', 'uc-a', 'error.test');
    await service.requestVerification('ws-a', 'uc-a', WorkspaceRole.OWNER, row.id);
    rows[0].verified = true;
    rows[0].verifiedAt = new Date('2026-10-01T00:00:00.000Z');
    resolver.resolveTxt.mockRejectedValue(new Error('SERVFAIL'));

    const result = await service.checkVerification(
      'ws-a',
      'scheduler',
      WorkspaceRole.OWNER,
      row.id,
      new Date('2026-10-12T01:00:00.000Z'),
    );

    expect(result.verified).toBe(true);
    expect(result.verifiedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(result.lastVerificationError).toBe('SERVFAIL');
  });

  it('re-checks verified domains daily without revoking them on failure', async () => {
    const row = await service.bindDomain('ws-a', 'uc-a', 'daily.test');
    await service.requestVerification('ws-a', 'uc-a', WorkspaceRole.OWNER, row.id);
    rows[0].verified = true;
    resolver.resolveTxt.mockResolvedValue([]);

    await expect(
      service.runVerificationSweep(new Date('2026-10-12T01:00:00.000Z')),
    ).resolves.toBe(1);

    expect(rows[0].verified).toBe(true);
    expect(rows[0].lastVerificationError).toMatch(/did not contain/);
  });
});
