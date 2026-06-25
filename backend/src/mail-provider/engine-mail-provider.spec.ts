import { MailboxAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { ConnectedAccountsEnginePort } from '../connected-accounts/connected-accounts.port';
import { EngineMailProvider } from './engine-mail-provider';

/**
 * EngineMailProvider: prove the external-provider chain (resolve the owning User
 * → KC broker token → credentials → cleaner-engine) maps results to the wire
 * shapes, picks the right alias/credentials per provider, and degrades clean
 * (no owner / no user / no token / dormant engine → [] or accepted:false).
 */
function gmailbox(over: Partial<MailboxAccount> = {}): MailboxAccount {
  return {
    id: 'mb-1',
    workspaceId: 'ws-1',
    emailAddress: 'person84@example.com',
    displayName: 'Me',
    provider: 'gmail',
    ownerKind: 'HUMAN',
    ownerKey: 'kc-sub-1',
    kind: 'gmail',
    ...over,
  } as MailboxAccount;
}

function make(opts: {
  token?: string | null;
  user?: { keycloakId: string } | null;
  threads?: unknown;
  thread?: unknown;
  send?: unknown;
  profile?: unknown;
}) {
  const broker = {
    getProviderAccessToken: jest.fn().mockResolvedValue(opts.token ?? null),
  } as unknown as KeycloakBrokerService;
  const engine = {
    getAccountProfile: jest.fn().mockResolvedValue(opts.profile ?? null),
    listMailThreads: jest.fn().mockResolvedValue(opts.threads ?? null),
    getMailThread: jest.fn().mockResolvedValue(opts.thread ?? null),
    sendMail: jest.fn().mockResolvedValue(opts.send ?? null),
  } as unknown as ConnectedAccountsEnginePort;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(opts.user ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.user ?? null),
    },
  } as unknown as PrismaService;
  return { provider: new EngineMailProvider(engine, broker, prisma), broker, engine, prisma };
}

describe('EngineMailProvider', () => {
  it('handles external providers only', () => {
    const { provider } = make({});
    expect(provider.handles({ provider: 'gmail' })).toBe(true);
    expect(provider.handles({ provider: 'microsoft' })).toBe(true);
    expect(provider.handles({ provider: 'stalwart' })).toBe(false);
  });

  it('listInbox: resolves user → google alias → engine, maps threads to ThreadView', async () => {
    const { provider, broker, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      threads: {
        threads: [
          {
            id: 't1',
            subject: 'Hi',
            participants: [{ address: 'a@x.test', name: 'A' }],
            last_message_at: '2026-06-24T00:00:00Z',
            last_snippet: 'hello',
            message_count: 2,
            unread: true,
          },
        ],
      },
    });
    const out = await provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 });
    expect(broker.getProviderAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ keycloakId: 'kc-sub-1' }),
      'google',
    );
    expect(engine.listMailThreads).toHaveBeenCalledWith('gmail', { token: 'gtok' }, 'inbox', 50);
    expect(out).toEqual([
      {
        id: 't1',
        subject: 'Hi',
        message_count: 2,
        unread: true,
        last_message_at: '2026-06-24T00:00:00Z',
        last_snippet: 'hello',
        participants: [{ address: 'a@x.test', name: 'A' }],
      },
    ]);
  });

  it('microsoft uses the microsoft alias + access_token credentials', async () => {
    const { provider, broker, engine } = make({ user: { keycloakId: 'kc-sub-1' }, token: 'mtok', threads: { threads: [] } });
    await provider.listInbox(gmailbox({ provider: 'microsoft', kind: 'microsoft' }), {
      folder: 'spam',
      limit: 25,
    });
    expect(broker.getProviderAccessToken).toHaveBeenCalledWith(expect.anything(), 'microsoft');
    expect(engine.listMailThreads).toHaveBeenCalledWith('microsoft', { access_token: 'mtok' }, 'spam', 25);
  });

  it('listInbox degrades clean: no owner / no user / no token / null engine → []', async () => {
    expect(await make({}).provider.listInbox(gmailbox({ ownerKey: null }), { folder: 'inbox', limit: 50 })).toEqual([]);
    expect(await make({ user: null }).provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 })).toEqual([]);
    expect(
      await make({ user: { keycloakId: 'kc-sub-1' }, token: null }).provider.listInbox(gmailbox(), {
        folder: 'inbox',
        limit: 50,
      }),
    ).toEqual([]);
    expect(
      await make({ user: { keycloakId: 'kc-sub-1' }, token: 'gtok', threads: null }).provider.listInbox(
        gmailbox(),
        { folder: 'inbox', limit: 50 },
      ),
    ).toEqual([]);
  });

  it('send: maps an accepted engine result; not-connected → accepted:false (engine never called)', async () => {
    const happy = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      send: { accepted: true, provider_message_id: 'pm-1', thread_id: 't9', reason: null },
    });
    const ok = await happy.provider.send(gmailbox(), { from: 'person84@example.com', to: 'x@y.test', subject: 's', body: 'b' });
    expect(ok).toEqual({ accepted: true, providerMessageId: 'pm-1', threadId: 't9', reason: null });

    const notConnected = make({ user: { keycloakId: 'kc-sub-1' }, token: null });
    const res = await notConnected.provider.send(gmailbox(), { from: 'person84@example.com', to: 'x@y.test', subject: 's', body: 'b' });
    expect(res).toEqual({ accepted: false, providerMessageId: null, threadId: null, reason: 'account_not_connected' });
    expect(notConnected.engine.sendMail).not.toHaveBeenCalled();
  });

  it('resolveOwnAddress returns the provider-authoritative address, lowercased', async () => {
    const { provider, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      profile: { email: 'Real.person84@example.com' },
    });
    expect(await provider.resolveOwnAddress('gmail', 'kc-sub-1')).toBe('real.person84@example.com');
    expect(engine.getAccountProfile).toHaveBeenCalledWith('gmail', { token: 'gtok' });
  });

  it('resolveOwnAddress degrades clean: no token / no profile / blank email → null', async () => {
    expect(await make({ user: { keycloakId: 'k' }, token: null }).provider.resolveOwnAddress('gmail', 'k')).toBeNull();
    expect(
      await make({ user: { keycloakId: 'k' }, token: 'gtok', profile: null }).provider.resolveOwnAddress('gmail', 'k'),
    ).toBeNull();
    expect(
      await make({ user: { keycloakId: 'k' }, token: 'gtok', profile: { email: '  ' } }).provider.resolveOwnAddress(
        'gmail',
        'k',
      ),
    ).toBeNull();
  });
});
