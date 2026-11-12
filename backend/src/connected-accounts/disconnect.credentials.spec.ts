import { ForbiddenException, Logger } from '@nestjs/common';
import { MailboxOwnerKind, User } from '@prisma/client';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { MembershipService } from '../common/workspace/membership.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectedAccountsController } from './connected-accounts.controller';
import { ConnectedAccountsService } from './connected-accounts.service';

/**
 * #82 mailbox Disconnect: credential-wipe contract, cross-workspace fence,
 * idempotency, and audit behavior.
 *
 * Hermetic unit spec. The DB layer is an in-memory fake (same shape the
 * existing connected-accounts specs mock) and the Keycloak broker HTTP calls
 * (access-token read, linked-identity DELETE) are an in-memory broker fake.
 * The disconnect code under test (ConnectedAccountsService /
 * ConnectedAccountsController) is REAL. Fictional identities only.
 *
 * Disconnect writes one workspace-scoped audit row without credentials.
 */
describe('mailbox Disconnect credential wipe (#82)', () => {
  const adaRefreshEnc = 'enc:ada-fictional-refresh-secret';
  const beaRefreshEnc = 'enc:bea-fictional-refresh-secret';

  const ada = {
    id: 'user-ada',
    email: 'ada@example.com',
    keycloakId: 'kc-ada',
    kcRefreshTokenEnc: adaRefreshEnc,
  } as User;
  const bea = {
    id: 'user-bea',
    email: 'bea@example.com',
    keycloakId: 'kc-bea',
    kcRefreshTokenEnc: beaRefreshEnc,
  } as User;

  interface Harness {
    rows: Row[];
    users: UserRow[];
    links: Map<string, string>;
    tx: FakeTx;
    prisma: { withWorkspace: jest.Mock; user: { update: jest.Mock } };
    broker: {
      getProviderAccessToken: jest.Mock;
      unlinkBrokerIdentity: jest.Mock;
    };
    membership: { resolveAndAuthorize: jest.Mock; listActiveMemberships: jest.Mock };
    service: ConnectedAccountsService;
    controller: ConnectedAccountsController;
    workspaceCalls: string[];
  }

  function harness(opts: {
    rows: Row[];
    users: UserRow[];
    links?: Array<{ alias: string; token: string }>;
    memberships?: Array<{ userKey: string; workspaceId: string; isDefault?: boolean }>;
  }): Harness {
    const { rows, users } = opts;
    const links = new Map<string, string>(
      (opts.links ?? []).map((link) => [link.alias, link.token]),
    );
    const memberships = opts.memberships ?? [
      { userKey: 'kc-ada', workspaceId: 'ws-a', isDefault: true },
      { userKey: 'kc-bea', workspaceId: 'ws-b', isDefault: true },
    ];
    const workspaceCalls: string[] = [];

    const tx: FakeTx = {
      mailboxAccount: {
        findMany: jest.fn(async ({ where }: any) => rows.filter((row) => matches(row, where))),
        findFirst: jest.fn(
          async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          const row = rows.find((item) => item.id === where.id);
          if (!row) throw new Error('missing mailbox row');
          Object.assign(row, data);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const row of rows) {
            if (!matches(row, where)) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        }),
        create: jest.fn(async () => {
          throw new Error('disconnect must not create mailbox rows');
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
        update: jest.fn(async ({ where, data }: any) => {
          const row = users.find((user) => user.id === where.id);
          if (!row) throw new Error('missing user row');
          Object.assign(row, data);
          return { ...row };
        }),
      },
      withWorkspace: jest.fn(async (workspaceId: string, _uc: string | null, fn: any) => {
        workspaceCalls.push(workspaceId);
        return fn(tx);
      }),
    };

    // Broker fake: models Keycloak as the access-token vault. Unlink removes
    // the linked identity, so any later token read for that alias is gone.
    const broker = {
      getProviderAccessToken: jest.fn(
        async (_user: unknown, alias: string) => links.get(alias) ?? null,
      ),
      unlinkBrokerIdentity: jest.fn(async (_user: unknown, alias: string) => {
        const alreadyAbsent = !links.has(alias);
        links.delete(alias);
        return { ok: true, alreadyAbsent, remainingAliases: [...links.keys()] };
      }),
    };

    // Membership fake: mirrors the tenancy-ON branch of MembershipService
    // (membership.service.ts:94-126): no active membership -> 403, requested
    // workspace the caller is not a member of -> 403.
    const membership = {
      resolveAndAuthorize: jest.fn(async (user: User, requested?: string | null) => {
        const mine = memberships.filter((m) => m.userKey === (user.keycloakId ?? user.id));
        if (mine.length === 0) {
          throw new ForbiddenException('No workspace access for this user.');
        }
        if (requested?.trim()) {
          if (!mine.some((m) => m.workspaceId === requested.trim())) {
            throw new ForbiddenException('Not a member of the requested workspace.');
          }
          return requested.trim();
        }
        const def = mine.find((m) => m.isDefault) ?? mine[0];
        return def.workspaceId;
      }),
      listActiveMemberships: jest.fn(async (user: User) =>
        memberships.filter((m) => m.userKey === (user.keycloakId ?? user.id)),
      ),
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
    return {
      rows,
      users,
      links,
      tx,
      prisma,
      broker,
      membership,
      service,
      controller,
      workspaceCalls,
    };
  }

  function silenceLogger(): () => void {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return () => {
      log.mockRestore();
      warn.mockRestore();
    };
  }

  describe('credential wipe', () => {
    it.each([
      { provider: 'gmail' as const, alias: 'google', address: 'ada@example.com' },
      { provider: 'microsoft' as const, alias: 'microsoft', address: 'ada.ms@example.com' },
    ])(
      'Disconnect of a linked $provider mailbox leaves no stored credential behind',
      async ({ provider, alias, address }) => {
        const restore = silenceLogger();
        try {
          const h = harness({
            rows: [
              box('box-ada', 'ws-a', provider, 'kc-ada', address, { isDefault: true }),
              box('box-team', 'ws-a', 'stalwart', null, 'team@example.com', {
                ownerKind: MailboxOwnerKind.SHARED,
              }),
            ],
            users: [
              { id: ada.id, kcRefreshTokenEnc: adaRefreshEnc },
              { id: bea.id, kcRefreshTokenEnc: beaRefreshEnc },
            ],
            links: [{ alias, token: 'fictional-access-token' }],
          });

          const result = await h.service.disconnectProvider(ada, provider);

          expect(result).toMatchObject({
            provider,
            status: 'disconnected',
            broker: 'unlinked',
            refresh_token_cleared: true,
          });
          // Provider revoke HTTP call (Keycloak linked-identity DELETE) happened.
          expect(h.broker.unlinkBrokerIdentity).toHaveBeenCalledWith(ada, alias);
          // Access token: the broker vault no longer holds the link, so a later
          // read returns nothing and the mailbox lists as unlinked.
          expect(h.links.has(alias)).toBe(false);
          await expect(h.broker.getProviderAccessToken(ada, alias)).resolves.toBeNull();
          await expect(h.service.listConnectedAccounts(ada)).resolves.toMatchObject({
            accounts: expect.arrayContaining([
              { provider, linked: false },
              { provider: provider === 'gmail' ? 'microsoft' : 'gmail', linked: false },
            ]),
          });
          // Refresh token (the encrypted secret column): nulled, and a later
          // read of the row shows none.
          expect(h.users.find((u) => u.id === ada.id)?.kcRefreshTokenEnc).toBeNull();
          // Mailbox row: deactivated, no secret reference, history kept.
          const boxRow = h.rows.find((row) => row.id === 'box-ada');
          expect(boxRow).toMatchObject({ active: false, secretRef: null });
          // Nothing anywhere still carries the secret value.
          const stored = JSON.stringify({ users: h.users, rows: h.rows, result });
          expect(stored).not.toContain(adaRefreshEnc);
          expect(stored).not.toContain('fictional-access-token');
          expect(h.tx.mailboxAccount.delete).not.toHaveBeenCalled();
          expect(h.tx.mailboxAccount.deleteMany).not.toHaveBeenCalled();
          // The other member's credential is untouched.
          expect(h.users.find((u) => u.id === bea.id)?.kcRefreshTokenEnc).toBe(beaRefreshEnc);
        } finally {
          restore();
        }
      },
    );
  });

  describe('cross-workspace fence', () => {
    it('deactivates only the caller workspaces, never a foreign workspace mailbox', async () => {
      const restore = silenceLogger();
      try {
        // Bea is a member of ws-b only. ws-a holds a gmail mailbox row keyed
        // with her own identity key (worst case); it must stay untouched.
        const h = harness({
          rows: [
            box('box-a', 'ws-a', 'gmail', 'kc-bea', 'bea@example.com'),
            box('box-b', 'ws-b', 'gmail', 'kc-bea', 'bea@example.com'),
          ],
          users: [{ id: bea.id, kcRefreshTokenEnc: beaRefreshEnc }],
          links: [{ alias: 'google', token: 'fictional-access-token' }],
        });

        const result = await h.service.disconnectProvider(bea, 'gmail');

        expect(result).toMatchObject({ status: 'disconnected', mailboxes_deactivated: 1 });
        expect(h.workspaceCalls).toContain('ws-b');
        expect(h.workspaceCalls).not.toContain('ws-a');
        expect(h.rows.find((row) => row.id === 'box-a')).toMatchObject({ active: true });
        expect(h.rows.find((row) => row.id === 'box-b')).toMatchObject({ active: false });
      } finally {
        restore();
      }
    });

    it('route refuses a caller with no membership in the target workspace with 403', async () => {
      const restore = silenceLogger();
      try {
        const h = harness({
          rows: [box('box-a', 'ws-a', 'gmail', 'kc-cid', 'cid@example.com')],
          users: [{ id: 'user-cid', kcRefreshTokenEnc: 'enc:cid-fictional-secret' }],
          links: [{ alias: 'google', token: 'fictional-access-token' }],
          // Cid has no active membership anywhere (the code's tenancy gate).
          memberships: [],
        });
        const cid = {
          id: 'user-cid',
          email: 'cid@example.com',
          keycloakId: 'kc-cid',
        } as User;

        await expect(h.controller.disconnect(cid, 'gmail')).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(h.broker.unlinkBrokerIdentity).not.toHaveBeenCalled();
        expect(h.rows.find((row) => row.id === 'box-a')).toMatchObject({ active: true });
        expect(h.users.find((u) => u.id === 'user-cid')?.kcRefreshTokenEnc).toBe(
          'enc:cid-fictional-secret',
        );
      } finally {
        restore();
      }
    });
  });

  describe('idempotency', () => {
    it('a second Disconnect does not throw and re-creates nothing', async () => {
      const restore = silenceLogger();
      try {
        const h = harness({
          rows: [box('box-ada', 'ws-a', 'gmail', 'kc-ada', 'ada@example.com')],
          users: [{ id: ada.id, kcRefreshTokenEnc: adaRefreshEnc }],
          links: [{ alias: 'google', token: 'fictional-access-token' }],
        });

        const first = await h.service.disconnectProvider(ada, 'gmail');
        const rowCount = h.rows.length;
        const second = await h.service.disconnectProvider(ada, 'gmail');

        expect(first).toMatchObject({ status: 'disconnected', broker: 'unlinked' });
        expect(second).toMatchObject({
          provider: 'gmail',
          status: 'disconnected',
          broker: 'already_absent',
          mailboxes_deactivated: 0,
        });
        expect(h.rows).toHaveLength(rowCount);
        expect(h.tx.mailboxAccount.create).not.toHaveBeenCalled();
        expect(h.tx.mailboxAccount.delete).not.toHaveBeenCalled();
        expect(h.tx.mailboxAccount.deleteMany).not.toHaveBeenCalled();
        expect(h.rows.find((row) => row.id === 'box-ada')).toMatchObject({ active: false });
        expect(h.users.find((u) => u.id === ada.id)?.kcRefreshTokenEnc).toBeNull();
        expect(h.links.size).toBe(0);
      } finally {
        restore();
      }
    });
  });

  describe('audit behavior', () => {
    it('Disconnect writes one audit event row without the broker token', async () => {
      const restore = silenceLogger();
      try {
        const h = harness({
          rows: [box('box-ada', 'ws-a', 'gmail', 'kc-ada', 'ada@example.com')],
          users: [{ id: ada.id, kcRefreshTokenEnc: adaRefreshEnc }],
          links: [{ alias: 'google', token: 'fictional-access-token' }],
        });

        await h.service.disconnectProvider(ada, 'gmail');

        expect(h.tx.agentActionEvent.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            workspaceId: 'ws-a',
            actorUcUid: 'kc-ada',
            kind: 'MAILBOX_UPDATED',
            detail: JSON.stringify({
              action: 'disconnect',
              provider: 'gmail',
              outcome: 'disconnected',
            }),
          }),
        });
        expect(JSON.stringify(h.tx.agentActionEvent.create.mock.calls)).not.toContain(
          adaRefreshEnc,
        );
      } finally {
        restore();
      }
    });
  });
});

type Row = ReturnType<typeof box>;
interface UserRow {
  id: string;
  kcRefreshTokenEnc: string | null;
}
interface FakeTx {
  mailboxAccount: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  agentActionEvent: { create: jest.Mock };
}

function box(
  id: string,
  workspaceId: string,
  provider: string,
  ownerKey: string | null,
  emailAddress: string,
  extra: { isDefault?: boolean; ownerKind?: MailboxOwnerKind } = {},
) {
  return {
    id,
    workspaceId,
    provider,
    ownerKind: extra.ownerKind ?? MailboxOwnerKind.HUMAN,
    ownerKey,
    emailAddress,
    // External rows never carry a secret or secret reference (the broker is
    // the vault); stalwart rows only ever hold an indirect reference.
    secretRef: null,
    isDefault: extra.isDefault ?? false,
    active: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  if (where.workspaceId && row.workspaceId !== where.workspaceId) return false;
  if (where.provider && row.provider !== where.provider) return false;
  if (where.ownerKind && row.ownerKind !== where.ownerKind) return false;
  if (where.ownerKey?.in && !where.ownerKey.in.includes(row.ownerKey)) return false;
  if (where.active === true && row.active !== true) return false;
  if (where.isDefault === true && row.isDefault !== true) return false;
  if (where.id?.notIn?.includes(row.id)) return false;
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  return true;
}
