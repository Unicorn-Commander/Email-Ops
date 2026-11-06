import { ConflictException } from '@nestjs/common';
import { MailboxAccount, MailboxOwnerKind, MailboxProvisionState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { DeviceConfigService } from './device-config.service';
import { MailboxAccountsService } from './mailbox-accounts.service';

describe('MailboxAccountsService.deleteMailbox', () => {
  const WS = '0190a000-7e57-7000-8000-00000000c002';

  const mailbox = {
    id: 'mb-delete',
    workspaceId: WS,
    emailAddress: 'delete-me@example.com',
    displayName: null,
    ownerKind: MailboxOwnerKind.SHARED,
    ownerKey: null,
    kind: 'shared',
    provider: 'stalwart',
    provisionState: MailboxProvisionState.PROVISIONED,
    isDefault: false,
    postmarkLane: false,
    active: false,
    createdAt: new Date('2026-11-06T00:00:00Z'),
    updatedAt: new Date('2026-11-06T00:00:00Z'),
  } as MailboxAccount;

  function make(overrides: {
    messages?: Array<{ threadId: string | null }>;
    agents?: number;
    kits?: number;
    standingApprovals?: number;
  } = {}) {
    const tx = {
      mailboxAccount: {
        findFirst: jest.fn().mockResolvedValue(mailbox),
        delete: jest.fn().mockResolvedValue(mailbox),
      },
      emailMessage: {
        findMany: jest.fn().mockResolvedValue(overrides.messages ?? []),
      },
      agent: { count: jest.fn().mockResolvedValue(overrides.agents ?? 0) },
      agentSendKit: { count: jest.fn().mockResolvedValue(overrides.kits ?? 0) },
      standingApproval: {
        count: jest.fn().mockResolvedValue(overrides.standingApprovals ?? 0),
      },
    };
    const prisma = {
      withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    };
    const service = new MailboxAccountsService(
      prisma as unknown as PrismaService,
      {} as MailEngineAdminPort,
      {} as DeviceConfigService,
    );
    return { service, tx };
  }

  it('deletes a parked mailbox with no references', async () => {
    const { service, tx } = make();

    await expect(service.deleteMailbox(WS, 'owner-1', mailbox.id)).resolves.toEqual({
      id: mailbox.id,
      deleted: true,
    });
    expect(tx.mailboxAccount.delete).toHaveBeenCalledWith({ where: { id: mailbox.id } });
  });

  it('returns every reference class as a 409 blocker and does not delete', async () => {
    const { service, tx } = make({
      messages: [{ threadId: 'thread-1' }, { threadId: 'thread-1' }, { threadId: null }],
      agents: 2,
      kits: 1,
      standingApprovals: 1,
    });

    let error: unknown;
    try {
      await service.deleteMailbox(WS, 'owner-1', mailbox.id);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      message: 'Mailbox cannot be deleted while it is still referenced.',
      blockers: {
        messages: 3,
        threads: 1,
        agents: 2,
        kits: 1,
        standing_approvals: 1,
      },
    });
    expect(tx.mailboxAccount.delete).not.toHaveBeenCalled();
  });
});
