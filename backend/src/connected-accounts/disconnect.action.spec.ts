import { ForbiddenException, Logger } from '@nestjs/common';
import { MailboxOwnerKind, User, WorkspaceRole } from '@prisma/client';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { MembershipService } from '../common/workspace/membership.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectedAccountsController } from './connected-accounts.controller';
import { ConnectedAccountsService } from './connected-accounts.service';

/**
 * #82 mailbox Disconnect action, unit level. Everything (broker links, mailbox
 * rows, user rows) is in-memory fakes: no broker, database, or network.
 *
 * The suite documents what the shipped code does. Three requested behaviors
 * are NOT implemented in the #82 code and are pinned with it.failing:
 *   - refusing a viewer-role member (the route gate is membership-only),
 *   - writing an audit entry (disconnectProvider writes none),
 *   - clearing the mailbox sync cursor (deactivation flips flags only).
 */
describe('mailbox disconnect action (#82)', () => {
  const refreshToken = 'fictional-refresh-token';
  const caller = {
    id: 'user-ada',
    email: 'ada@example.com',
    keycloakId: 'kc-ada',
    kcRefreshTokenEnc: refreshToken,
  } as User;
  const otherUser = {
    id: 'user-bea',
    email: 'bea@example.com',
    keycloakId: 'kc-bea',
    kcRefreshTokenEnc: 'fictional-bea-refresh-token',
  } as User;

  function freshRows() {
    return [
      box('mine', 'ws-1', 'gmail', 'kc-ada', 'ada@example.com'),
      box('mine-cursor', 'ws-1', 'gmail', 'kc-ada', 'ada.sync@example.com', {
        inboundCursor: '2026-01-01T00:00:00.000Z',
      }),
      box('team', 'ws-1', 'stalwart', null, 'team@example.com', {
        ownerKind: MailboxOwnerKind.SHARED,
        isDefault: true,
      }),
      box('other-user', 'ws-1', 'gmail', 'kc-bea', 'bea@example.com'),
      box('mine-ms', 'ws-1', 'microsoft', 'kc-ada', 'ada.ms@example.com'),
    ];
  }

  function harness(rows = freshRows()) {
    const users = [
      { id: caller.id, kcRefreshTokenEnc: refreshToken as string | null },
      { id: otherUser.id, kcRefreshTokenEnc: 'fictional-bea-refresh-token' as string | null },
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
      agentActionEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
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
        remainingAliases: [] as string[],
      }),
    };
    const membership = {
      resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1'),
      listActiveMemberships: jest.fn().mockResolvedValue([{ workspaceId: 'ws-1' }]),
      resolveWithRole: jest.fn(),
    };
    const service = new ConnectedAccountsService(
      broker as unknown as KeycloakBrokerService,
      membership as unknown as MembershipService,
      {} as never,
      prisma as unknown as PrismaService,
      {} as never,
    );
    const controller = new ConnectedAccountsController(
      membership as unknown as MembershipService,
      service,
    );
    return { rows, users, tx, prisma, broker, membership, service, controller };
  }

  function silenceLogger() {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return () => {
      log.mockRestore();
      warn.mockRestore();
    };
  }

  describe('credential removal', () => {
    it('clears the stored broker credential when no other provider link remains', async () => {
      const restore = silenceLogger();
      try {
        const { users, prisma, service } = harness();

        const result = await service.disconnectProvider(caller, 'gmail');

        expect(result).toMatchObject({
          provider: 'gmail',
          status: 'disconnected',
          broker: 'unlinked',
          refresh_token_cleared: true,
        });
        expect(prisma.user.update).toHaveBeenCalledWith({
          where: { id: caller.id },
          data: { kcRefreshTokenEnc: null, kcRefreshUpdatedAt: expect.any(Date) },
        });
        expect(users.find((user) => user.id === caller.id)?.kcRefreshTokenEnc).toBeNull();
        const leaked = JSON.stringify(prisma.user.update.mock.calls);
        expect(leaked.includes(refreshToken)).toBe(false);
      } finally {
        restore();
      }
    });

    it('keeps the shared credential while the other provider link still exists', async () => {
      const restore = silenceLogger();
      try {
        const { users, prisma, broker, service } = harness();
        broker.unlinkBrokerIdentity.mockResolvedValue({
          ok: true,
          alreadyAbsent: false,
          remainingAliases: ['microsoft'],
        });

        const result = await service.disconnectProvider(caller, 'gmail');

        expect(result).toMatchObject({ status: 'disconnected', refresh_token_cleared: false });
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(users.find((user) => user.id === caller.id)?.kcRefreshTokenEnc).toBe(refreshToken);
      } finally {
        restore();
      }
    });

    it('deactivates the caller mailbox rows and deletes nothing', async () => {
      const restore = silenceLogger();
      try {
        const { rows, tx, service } = harness();

        const result = await service.disconnectProvider(caller, 'gmail');

        expect(result).toMatchObject({ mailboxes_deactivated: 2 });
        expect(rows.find((row) => row.id === 'mine')?.active).toBe(false);
        expect(rows.find((row) => row.id === 'mine-cursor')?.active).toBe(false);
        expect(rows.find((row) => row.id === 'other-user')?.active).toBe(true);
        expect(rows.find((row) => row.id === 'mine-ms')?.active).toBe(true);
        expect(rows.find((row) => row.id === 'team')?.active).toBe(true);
        expect(tx.mailboxAccount.delete).not.toHaveBeenCalled();
        expect(tx.mailboxAccount.deleteMany).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });

  describe('idempotency', () => {
    it('second disconnect succeeds as already_absent with no error', async () => {
      const restore = silenceLogger();
      try {
        const { rows, broker, service } = harness();

        const first = await service.disconnectProvider(caller, 'gmail');
        broker.unlinkBrokerIdentity.mockResolvedValue({
          ok: true,
          alreadyAbsent: true,
          remainingAliases: [],
        });
        const second = await service.disconnectProvider(caller, 'gmail');

        expect(first).toMatchObject({ status: 'disconnected', broker: 'unlinked' });
        expect(second).toMatchObject({
          provider: 'gmail',
          status: 'disconnected',
          broker: 'already_absent',
          mailboxes_deactivated: 0,
        });
        expect(broker.unlinkBrokerIdentity).toHaveBeenCalledTimes(2);
        expect(rows.filter((row) => row.active === false)).toHaveLength(2);
      } finally {
        restore();
      }
    });

    it('route-level second call also resolves without throwing', async () => {
      const restore = silenceLogger();
      try {
        const { broker, controller } = harness();

        await expect(controller.disconnect(caller, 'gmail')).resolves.toMatchObject({
          status: 'disconnected',
        });
        broker.unlinkBrokerIdentity.mockResolvedValue({
          ok: true,
          alreadyAbsent: true,
          remainingAliases: [],
        });
        await expect(controller.disconnect(caller, 'gmail')).resolves.toMatchObject({
          status: 'disconnected',
          broker: 'already_absent',
        });
      } finally {
        restore();
      }
    });
  });

  describe('requested policy not in the #82 code (it.failing)', () => {
    it.failing('refuses a viewer-role member', async () => {
      const restore = silenceLogger();
      try {
        const { broker, membership, controller } = harness();
        // A viewer still holds an active membership, and the route gate
        // (resolveAndAuthorize) only checks membership, never the role.
        membership.resolveWithRole.mockResolvedValue({
          workspaceId: 'ws-1',
          role: WorkspaceRole.VIEWER,
        });

        await expect(controller.disconnect(caller, 'gmail')).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(broker.unlinkBrokerIdentity).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it.failing('writes an audit entry for the disconnect', async () => {
      const restore = silenceLogger();
      try {
        const { tx, service } = harness();

        await service.disconnectProvider(caller, 'gmail');

        expect(tx.agentActionEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ workspaceId: 'ws-1' }),
          }),
        );
      } finally {
        restore();
      }
    });

    it.failing('clears the mailbox sync cursor on disconnect', async () => {
      const restore = silenceLogger();
      try {
        const { rows, service } = harness();

        await service.disconnectProvider(caller, 'gmail');

        expect(rows.find((row) => row.id === 'mine-cursor')).toMatchObject({
          active: false,
          inboundCursor: null,
        });
      } finally {
        restore();
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
  extra: {
    isDefault?: boolean;
    ownerKind?: MailboxOwnerKind;
    inboundCursor?: string | null;
  } = {},
) {
  const ownerKind = extra.ownerKind ?? MailboxOwnerKind.HUMAN;
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
    isDefault: extra.isDefault ?? false,
    postmarkLane: false,
    active: true,
    inboundCursor: extra.inboundCursor ?? null,
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
