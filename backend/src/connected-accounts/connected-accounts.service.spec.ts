import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import { ConnectedAccountsService } from './connected-accounts.service';
import { encrypt } from './crypto';
import { PrismaService } from '../prisma/prisma.service';

const KEY = Buffer.alloc(32, 7).toString('base64');

class FakeEngine extends ConnectedAccountsEnginePort {
  public configured = true;
  public inboxStatsCalls: Array<{ provider: string; credentials: Record<string, unknown> }> = [];
  public analyzeCalls: Array<{ provider: string; credentials: Record<string, unknown> }> = [];
  public exchangeCalls: Array<{ provider: string; code: string; redirectUri: string }> = [];
  public profileCalls: Array<{ provider: string; credentials: Record<string, unknown> }> = [];

  isConfigured(): boolean {
    return this.configured;
  }

  async getOAuthUrl(): Promise<string | null> {
    return null;
  }

  async exchangeCode(provider: string, code: string, redirectUri: string): Promise<Record<string, unknown> | null> {
    this.exchangeCalls.push({ provider, code, redirectUri });
    return { access_token: 'at', refresh_token: 'rt' };
  }

  async getProfile(provider: string, credentials: Record<string, unknown>) {
    this.profileCalls.push({ provider, credentials });
    return {
      email: 'desk@example.com',
      display_name: 'Desk',
      total_messages: 10,
      total_threads: 3,
      storage_used_bytes: 99,
      storage_limit_bytes: 1000,
    };
  }

  async getInboxStats(provider: string, credentials: Record<string, unknown>) {
    this.inboxStatsCalls.push({ provider, credentials });
    return {
      total_messages: 10,
      total_threads: 3,
      unread_count: 2,
      promotional_count: 1,
      social_count: 0,
      storage_used_bytes: 99,
    };
  }

  async analyzeInbox(provider: string, credentials: Record<string, unknown>) {
    this.analyzeCalls.push({ provider, credentials });
    return { result: 'ok', provider };
  }
}

describe('ConnectedAccountsService', () => {
  const workspaceId = '0190a000-7e57-7000-8000-0000000ecccc';
  const ucUid = 'uc-uid-test';
  const prevKey = process.env.CONNECTED_ACCOUNT_ENC_KEY;

  beforeEach(() => {
    process.env.CONNECTED_ACCOUNT_ENC_KEY = KEY;
  });

  afterEach(() => {
    if (prevKey === undefined) {
      delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    } else {
      process.env.CONNECTED_ACCOUNT_ENC_KEY = prevKey;
    }
  });

  function makePrisma(rows: any[]) {
    const tx = {
      connectedAccount: {
        findMany: jest.fn().mockResolvedValue(rows),
        findUnique: jest.fn().mockImplementation(async ({ where }) => rows.find((r) => r.id === where.id) ?? null),
        upsert: jest.fn().mockImplementation(async ({ where, update, create }) => {
          const existingIndex = rows.findIndex(
            (r) =>
              r.workspaceId === where.workspaceId_provider_emailAddress.workspaceId &&
              r.provider === where.workspaceId_provider_emailAddress.provider &&
              r.emailAddress === where.workspaceId_provider_emailAddress.emailAddress,
          );
          const now = new Date('2026-06-04T12:00:00.000Z');
          const next = existingIndex >= 0
            ? { ...rows[existingIndex], ...update, updatedAt: now }
            : { id: `acct-${rows.length + 1}`, createdAt: now, updatedAt: now, credentialsExpireAt: null, lastAnalyzedAt: null, ...create };
          if (existingIndex >= 0) {
            rows[existingIndex] = next;
          } else {
            rows.push(next);
          }
          return next;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const idx = rows.findIndex((r) => r.id === where.id);
          if (idx < 0) throw new Error('not found');
          rows[idx] = { ...rows[idx], ...data, updatedAt: new Date('2026-06-04T12:05:00.000Z') };
          return rows[idx];
        }),
      },
    };

    return {
      withWorkspace: jest.fn(async (_workspaceId: string, _ucUid: string | null, fn: any) => fn(tx)),
    } as unknown as PrismaService;
  }

  function makeService(engine: FakeEngine, rows: any[]) {
    return new ConnectedAccountsService(makePrisma(rows), engine);
  }

  it('listConnectedAccounts returns views without encryptedCredentials', async () => {
    const rows = [
      {
        id: 'acct-1',
        workspaceId,
        provider: 'gmail',
        emailAddress: 'desk@example.com',
        displayName: 'Desk',
        status: 'active',
        encryptedCredentials: 'secret',
        credentialsExpireAt: null,
        lastAnalyzedAt: null,
        createdAt: new Date('2026-06-04T12:00:00.000Z'),
        updatedAt: new Date('2026-06-04T12:00:00.000Z'),
      },
    ];
    const service = makeService(new FakeEngine(), rows);
    const result = await service.listConnectedAccounts(workspaceId, ucUid);
    expect(result.count).toBe(1);
    expect(result.accounts[0]).toMatchObject({
      id: 'acct-1',
      provider: 'gmail',
      emailAddress: 'desk@example.com',
      status: 'active',
    });
    expect(result.accounts[0]).not.toHaveProperty('encryptedCredentials');
  });

  it('getInboxStats decrypts creds and calls the engine', async () => {
    const encryptedCredentials = encrypt({ access_token: 'at-1', refresh_token: 'rt-1' });
    const rows = [
      {
        id: 'acct-1',
        workspaceId,
        provider: 'gmail',
        emailAddress: 'desk@example.com',
        displayName: 'Desk',
        status: 'active',
        encryptedCredentials,
        credentialsExpireAt: null,
        lastAnalyzedAt: null,
        createdAt: new Date('2026-06-04T12:00:00.000Z'),
        updatedAt: new Date('2026-06-04T12:00:00.000Z'),
      },
    ];
    const engine = new FakeEngine();
    const service = makeService(engine, rows);

    const result = await service.getInboxStats(workspaceId, ucUid, 'acct-1');
    expect(result.engineAvailable).toBe(true);
    expect(engine.inboxStatsCalls[0]).toEqual({
      provider: 'gmail',
      credentials: { access_token: 'at-1', refresh_token: 'rt-1' },
    });
    expect(result.inboxStats).toMatchObject({
      total_messages: 10,
      unread_count: 2,
    });
  });

  it('analyzeInbox decrypts creds, calls the engine, and stamps lastAnalyzedAt', async () => {
    const encryptedCredentials = encrypt({ access_token: 'at-2', refresh_token: 'rt-2' });
    const rows = [
      {
        id: 'acct-1',
        workspaceId,
        provider: 'microsoft',
        emailAddress: 'desk@example.com',
        displayName: 'Desk',
        status: 'active',
        encryptedCredentials,
        credentialsExpireAt: null,
        lastAnalyzedAt: null,
        createdAt: new Date('2026-06-04T12:00:00.000Z'),
        updatedAt: new Date('2026-06-04T12:00:00.000Z'),
      },
    ];
    const engine = new FakeEngine();
    const service = makeService(engine, rows);

    const result = await service.analyzeInbox(workspaceId, ucUid, 'acct-1');
    expect(result.engineAvailable).toBe(true);
    expect(engine.analyzeCalls[0]).toEqual({
      provider: 'microsoft',
      credentials: { access_token: 'at-2', refresh_token: 'rt-2' },
    });
    expect(result.account.lastAnalyzedAt).not.toBeNull();
    expect(rows[0].lastAnalyzedAt).toBeInstanceOf(Date);
  });

  it('degrades cleanly when the cleaner engine is unavailable', async () => {
    const rows = [
      {
        id: 'acct-1',
        workspaceId,
        provider: 'gmail',
        emailAddress: 'desk@example.com',
        displayName: 'Desk',
        status: 'active',
        encryptedCredentials: encrypt({ access_token: 'at-3', refresh_token: 'rt-3' }),
        credentialsExpireAt: null,
        lastAnalyzedAt: null,
        createdAt: new Date('2026-06-04T12:00:00.000Z'),
        updatedAt: new Date('2026-06-04T12:00:00.000Z'),
      },
    ];
    const engine = new FakeEngine();
    engine.configured = false;
    const service = makeService(engine, rows);

    await expect(service.getInboxStats(workspaceId, ucUid, 'acct-1')).resolves.toMatchObject({
      engineAvailable: false,
      inboxStats: null,
    });
    await expect(service.analyzeInbox(workspaceId, ucUid, 'acct-1')).resolves.toMatchObject({
      engineAvailable: false,
      analysis: null,
    });
    expect(engine.inboxStatsCalls).toHaveLength(0);
    expect(engine.analyzeCalls).toHaveLength(0);
  });
});
