import { Logger } from '@nestjs/common';
import { MailboxOwnerKind, User, WorkspaceRole } from '@prisma/client';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { MembershipService } from '../common/workspace/membership.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectedAccountsController } from './connected-accounts.controller';
import { ConnectedAccountsService } from './connected-accounts.service';
import { MailboxAccountsService } from '../mailbox-accounts/mailbox-accounts.service';

/**
 * #82 mailbox Disconnect. Tokens and the active mailbox list are in-memory:
 * no broker, database, or network.
 */
describe('mailbox disconnect regression (#82)', () => {
  const refreshToken = 'fictional-refresh-token';
  const otherRefreshToken = 'fictional-other-refresh-token';
  const caller = {
    id: 'user-ada',
    email: 'ada@example.com',
    keycloakId: 'kc-ada',
    kcRefreshTokenEnc: refreshToken,
  } as User;
  const otherUser = {
    id: 'user-bea',
    email: 'bea@example.com',
    keycloakId: 'kc-other',
    kcRefreshTokenEnc: otherRefreshToken,
  } as User;

  function freshRows() {
    return [
      box('mine', 'ws-1', 'gmail', 'kc-ada', 'ada@example.com', false),
      box('team', 'ws-1', 'stalwart', null, 'team@example.com', true, MailboxOwnerKind.SHARED),
      box('other-user', 'ws-1', 'gmail', 'kc-other', 'other@example.com', false),
      box('mine-ms', 'ws-1', 'microsoft', 'kc-ada', 'ada.ms@example.com', false),
      box('foreign', 'ws-2', 'gmail', 'kc-other', 'foreign@example.com', false),
      box('desk', 'ws-2', 'stalwart', null, 'desk@example.com', true, MailboxOwnerKind.SHARED),
      box('mine-ws2', 'ws-2', 'gmail', 'kc-ada', 'ada.other@example.com', false),
    ];
  }

  function harness(rows = freshRows()) {
    const users = [
      { id: caller.id, kcRefreshTokenEnc: refreshToken as string | null },
      { id: otherUser.id, kcRefreshTokenEnc: otherRefreshToken as string | null },
    ];
    const tx = {
      mailboxAccount: {
        findMany: jest.fn(async ({ where }) => rows.filter((row) => matches(row, where))),
        findFirst: jest.fn(async ({ where }) => rows.find((row) => matches(row, where)) ?? null),
        update: jest.fn(async ({ where, data }) => {
          const row = rows.find((item) => item.id === where.id);
          if (!row) throw new Error('missing mailbox');
          Object.assign(row, data);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }) => {
          let count = 0;
          for (const row of rows) {
            if (!matches(row, where)) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        }),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      agentMailbox: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const prisma = {
      user: {
        update: jest.fn(async ({ where, data }) => {
          const row = users.find((user) => user.id === where.id);
          if (!row) throw new Error('missing user');
          Object.assign(row, data);
          return { ...row };
        }),
      },
      withWorkspace: jest.fn(
        async (_workspace: string, _uc: string | null, fn: (db: typeof tx) => unknown) => fn(tx),
      ),
    };
    const broker = {
      unlinkBrokerIdentity: jest.fn().mockResolvedValue({
        ok: true,
        alreadyAbsent: false,
        remainingAliases: [],
      }),
    };
    const membership = {
      resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1'),
      listActiveMemberships: jest
        .fn()
        .mockResolvedValue([{ workspaceId: 'ws-1' }, { workspaceId: 'ws-2' }]),
      resolveWithRole: jest.fn(),
    };
    const service = new ConnectedAccountsService(
      broker as unknown as KeycloakBrokerService,
      membership as unknown as MembershipService,
      {} as never,
      prisma as unknown as PrismaService,
      {} as never,
    );
    const mailboxes = new MailboxAccountsService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
    );
    return { rows, users, tx, prisma, broker, membership, service, mailboxes };
  }

  async function activeList(mailboxes: MailboxAccountsService, workspaceId: string) {
    const listed = await mailboxes.listMailboxes(workspaceId, 'kc-ada');
    return listed.filter((mailbox) => mailbox.active !== false);
  }

  it('revokes that mailbox token, drops it from the active list, and leaves other mailboxes', async () => {
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { rows, tx, prisma, broker, service, mailboxes } = harness();
    const untouched = ['team', 'other-user', 'mine-ms', 'foreign', 'desk'].map((id) => ({
      ...rows.find((row) => row.id === id),
    }));

    const result = await service.disconnectProvider(caller, 'gmail');

    expect(broker.unlinkBrokerIdentity).toHaveBeenCalledTimes(1);
    expect(broker.unlinkBrokerIdentity).toHaveBeenCalledWith(caller, 'google');
    expect(result).toMatchObject({
      provider: 'gmail',
      status: 'disconnected',
      broker: 'unlinked',
      refresh_token_cleared: true,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-ada' },
      data: { kcRefreshTokenEnc: null, kcRefreshUpdatedAt: expect.any(Date) },
    });
    expect(rows.find((row) => row.id === 'mine')?.active).toBe(false);
    expect(tx.mailboxAccount.delete).not.toHaveBeenCalled();
    expect(tx.mailboxAccount.deleteMany).not.toHaveBeenCalled();

    const ws1 = (await activeList(mailboxes, 'ws-1')).map((mailbox) => mailbox.email_address);
    expect(ws1).not.toContain('ada@example.com');
    expect(ws1).toEqual(
      expect.arrayContaining(['team@example.com', 'other@example.com', 'ada.ms@example.com']),
    );
    const ws2 = await activeList(mailboxes, 'ws-2');
    expect(ws2.map((mailbox) => mailbox.email_address)).toEqual(
      expect.arrayContaining(['foreign@example.com', 'desk@example.com']),
    );
    for (const before of untouched) {
      expect(rows.find((row) => row.id === before.id)).toMatchObject({
        emailAddress: before.emailAddress,
        provider: before.provider,
        ownerKey: before.ownerKey,
        workspaceId: before.workspaceId,
        active: true,
      });
    }
    const leaked = JSON.stringify({
      result,
      logs: [...logs.mock.calls, ...warn.mock.calls],
      update: prisma.user.update.mock.calls,
    });
    expect(leaked.includes(refreshToken)).toBe(false);
    logs.mockRestore();
    warn.mockRestore();
  });

  it("deactivates only this user's mailboxes and leaves the other user's tokens", async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { rows, users, prisma, broker, service, mailboxes } = harness();

      await service.disconnectProvider(caller, 'gmail');

      // The broker link is user-global, so this user's gmail row drops in every workspace.
      expect(rows.find((row) => row.id === 'mine')).toMatchObject({ active: false });
      expect(rows.find((row) => row.id === 'mine-ws2')).toMatchObject({ active: false });
      expect(rows.find((row) => row.id === 'mine-ms')?.active).toBe(true);

      expect(rows.find((row) => row.id === 'other-user')).toMatchObject({
        active: true,
        ownerKey: 'kc-other',
        workspaceId: 'ws-1',
        provider: 'gmail',
      });
      expect(rows.find((row) => row.id === 'foreign')).toMatchObject({
        active: true,
        ownerKey: 'kc-other',
        workspaceId: 'ws-2',
        provider: 'gmail',
      });
      expect(rows.find((row) => row.id === 'team')?.active).toBe(true);
      expect(rows.find((row) => row.id === 'desk')?.active).toBe(true);

      const ws1 = (await activeList(mailboxes, 'ws-1')).map((mailbox) => mailbox.email_address);
      expect(ws1).toContain('other@example.com');
      expect(ws1).not.toContain('ada@example.com');
      const ws2 = (await activeList(mailboxes, 'ws-2')).map((mailbox) => mailbox.email_address);
      expect(ws2).toContain('foreign@example.com');
      expect(ws2).not.toContain('ada.other@example.com');

      expect(users.find((user) => user.id === otherUser.id)?.kcRefreshTokenEnc).toBe(
        otherRefreshToken,
      );
      expect(users.find((user) => user.id === caller.id)?.kcRefreshTokenEnc).toBeNull();
      expect(prisma.user.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: otherUser.id } }),
      );
      expect(broker.unlinkBrokerIdentity).toHaveBeenCalledTimes(1);
      expect(broker.unlinkBrokerIdentity).toHaveBeenCalledWith(caller, 'google');
      expect(broker.unlinkBrokerIdentity).not.toHaveBeenCalledWith(otherUser, expect.anything());
      const leaked = JSON.stringify({
        logs: [...log.mock.calls, ...warn.mock.calls],
        update: prisma.user.update.mock.calls,
      });
      expect(leaked.includes(refreshToken)).toBe(false);
      expect(leaked.includes(otherRefreshToken)).toBe(false);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("does not let one user disconnect another user's account", async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const { rows, users, prisma, broker, membership, service } = harness();
      const controller = new ConnectedAccountsController(
        membership as unknown as MembershipService,
        service,
      );

      await controller.disconnect(caller, 'gmail');

      expect(broker.unlinkBrokerIdentity).toHaveBeenCalledTimes(1);
      expect(broker.unlinkBrokerIdentity).toHaveBeenCalledWith(caller, 'google');
      expect(broker.unlinkBrokerIdentity).not.toHaveBeenCalledWith(otherUser, expect.anything());
      expect(rows.find((row) => row.id === 'other-user')?.active).toBe(true);
      expect(rows.find((row) => row.id === 'foreign')?.active).toBe(true);
      expect(users.find((user) => user.id === otherUser.id)?.kcRefreshTokenEnc).toBe(
        otherRefreshToken,
      );
      expect(prisma.user.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: otherUser.id } }),
      );

      // The route has no target user. Only Bea, signed in as herself, can unlink Bea.
      broker.unlinkBrokerIdentity.mockClear();
      prisma.user.update.mockClear();
      await controller.disconnect(otherUser, 'gmail');

      expect(broker.unlinkBrokerIdentity).toHaveBeenCalledTimes(1);
      expect(broker.unlinkBrokerIdentity).toHaveBeenCalledWith(otherUser, 'google');
      expect(broker.unlinkBrokerIdentity).not.toHaveBeenCalledWith(caller, expect.anything());
      expect(rows.find((row) => row.id === 'other-user')?.active).toBe(false);
      expect(rows.find((row) => row.id === 'foreign')?.active).toBe(false);
      expect(rows.find((row) => row.id === 'mine')?.active).toBe(false);
      expect(rows.find((row) => row.id === 'mine-ms')?.active).toBe(true);
      expect(rows.find((row) => row.id === 'team')?.active).toBe(true);
      expect(rows.find((row) => row.id === 'desk')?.active).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: otherUser.id } }),
      );
      expect(prisma.user.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: caller.id } }),
      );
      expect(users.find((user) => user.id === caller.id)?.kcRefreshTokenEnc).toBeNull();
      expect(users.find((user) => user.id === otherUser.id)?.kcRefreshTokenEnc).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  describe('who may disconnect', () => {
    function controllerFor(role: WorkspaceRole) {
      const membership = {
        resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1'),
        resolveWithRole: jest.fn().mockResolvedValue({ workspaceId: 'ws-1', role }),
      };
      const connectedAccounts = {
        disconnectProvider: jest.fn().mockResolvedValue({
          provider: 'gmail',
          status: 'disconnected',
          broker: 'unlinked',
          mailboxes_deactivated: 1,
          refresh_token_cleared: true,
        }),
      };
      return {
        controller: new ConnectedAccountsController(
          membership as unknown as MembershipService,
          connectedAccounts as never,
        ),
        connectedAccounts,
      };
    }

    it.each([WorkspaceRole.OWNER, WorkspaceRole.ADMIN])(
      'allows a workspace %s to disconnect',
      async (role) => {
        const { controller, connectedAccounts } = controllerFor(role);
        await expect(controller.disconnect(caller, 'gmail')).resolves.toMatchObject({
          status: 'disconnected',
        });
        expect(connectedAccounts.disconnectProvider).toHaveBeenCalledWith(caller, 'gmail');
      },
    );

    it('lets a workspace member disconnect their own account', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        const { rows, broker, membership, service } = harness();
        membership.resolveWithRole.mockResolvedValue({
          workspaceId: 'ws-1',
          role: WorkspaceRole.MEMBER,
        });
        const controller = new ConnectedAccountsController(
          membership as unknown as MembershipService,
          service,
        );

        await expect(controller.disconnect(caller, 'gmail')).resolves.toMatchObject({
          provider: 'gmail',
          status: 'disconnected',
        });
        expect(membership.resolveAndAuthorize).toHaveBeenCalledWith(caller, null);
        expect(broker.unlinkBrokerIdentity).toHaveBeenCalledTimes(1);
        expect(broker.unlinkBrokerIdentity).toHaveBeenCalledWith(caller, 'google');
        expect(broker.unlinkBrokerIdentity).not.toHaveBeenCalledWith(otherUser, expect.anything());
        expect(rows.find((row) => row.id === 'mine')?.active).toBe(false);
        expect(rows.find((row) => row.id === 'other-user')?.active).toBe(true);
      } finally {
        log.mockRestore();
      }
    });
  });
});

function box(
  id: string,
  workspaceId: string,
  provider: string,
  ownerKey: string | null,
  emailAddress: string,
  isDefault: boolean,
  ownerKind: MailboxOwnerKind = MailboxOwnerKind.HUMAN,
) {
  return {
    id,
    workspaceId,
    provider,
    ownerKind,
    ownerKey,
    emailAddress,
    displayName: null,
    kind: ownerKind === MailboxOwnerKind.SHARED ? 'shared' : 'human',
    provisionState: 'REGISTERED',
    isDefault,
    postmarkLane: false,
    active: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function matches(row: ReturnType<typeof box>, where: any): boolean {
  if (!where) return true;
  if (where.workspaceId && row.workspaceId !== where.workspaceId) return false;
  if (where.provider && row.provider !== where.provider) return false;
  if (where.ownerKind && row.ownerKind !== where.ownerKind) return false;
  if (where.ownerKey?.in && !where.ownerKey.in.includes(row.ownerKey)) return false;
  if (where.active === true && row.active !== true) return false;
  if (where.isDefault === true && row.isDefault !== true) return false;
  if (where.id?.notIn?.includes(row.id)) return false;
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  return true;
}
