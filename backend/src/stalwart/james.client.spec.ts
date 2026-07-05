import { ConfigService } from '@nestjs/config';
import { JamesClient } from './james.client';

/**
 * JamesClient is the delegation-aware James (JMAP) adapter. Load-bearing here:
 * (1) degrade-clean — with JAMES_JMAP_URL unset it is fully dormant; (2) the
 * DELEGATION map — session.accounts (address→accountId, own + delegated) is
 * cached and account-scoped calls run under the TARGET mailbox's own account,
 * matched case-insensitively; (3) an unknown address re-fetches the session
 * ONCE (a delegation may have been granted since boot) and then falls back to
 * the primary accountId — the pre-delegation behavior.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** The live shape: accounts keyed by accountId, `name` = the mailbox address. */
const SESSION = {
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-hq' },
  accounts: {
    'acct-hq': { name: 'hq@unicorncommander.ai' },
    'acct-sales': { name: 'sales@unicorncommander.ai' },
  },
};

const CONFIGURED = {
  JAMES_JMAP_URL: 'https://james.example.test/jmap/',
  JAMES_JMAP_BASIC: 'hq@unicorncommander.ai:secret',
};

/** Mock fetch: GET /session serves sessions (in order, last repeats); POST serves JMAP. */
function mockJmapFetch(sessions: unknown[], jmapBody: unknown = { methodResponses: [] }) {
  const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
    if (String(url).endsWith('/session')) {
      const i = sessionCalls(fetchSpy).length - 1;
      return jsonResponse(sessions[Math.min(i, sessions.length - 1)]);
    }
    return jsonResponse(jmapBody);
  });
  return fetchSpy;
}

function sessionCalls(fetchSpy: jest.Mock): unknown[][] {
  return fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/session'));
}

/** The accountId a POSTed JMAP method call was scoped to. */
function accountIdOf(fetchSpy: jest.Mock, method: string, nth = 0): string | undefined {
  const posts = fetchSpy.mock.calls.filter(([u]) => !String(u).endsWith('/session'));
  const bodies = posts.map(([, init]) => JSON.parse((init as RequestInit).body as string));
  const calls = bodies.flatMap((b) => b.methodCalls as any[]).filter((c) => c[0] === method);
  return calls[nth]?.[1]?.accountId;
}

describe('JamesClient', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('degrade-clean: JAMES_JMAP_URL unset (dormant)', () => {
    const client = new JamesClient(makeConfig({}));

    it('isConfigured() is false and reads return [] WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      expect(client.isConfigured()).toBe(false);
      await expect(client.listThreads('desk@x.test', 'jane@acme.test')).resolves.toEqual([]);
      await expect(client.listMessages('desk@x.test', 'thread-1')).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('delegation-aware account resolution', () => {
    it('builds the address→accountId map from session.accounts and scopes reads to the delegated account (case-insensitive)', async () => {
      const fetchSpy = mockJmapFetch([SESSION]);
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      // Mixed-case mailbox address → the sales account, not the primary.
      await client.listThreads('Sales@UnicornCommander.AI', 'jane@acme.test');
      expect(accountIdOf(fetchSpy, 'Email/query', 0)).toBe('acct-sales');

      // The primary's own mailbox resolves to the primary; the session was
      // fetched exactly once (the map is cached, no per-read /session hit).
      await client.listMessages('hq@unicorncommander.ai', 'thread-1');
      expect(accountIdOf(fetchSpy, 'Thread/get', 1)).toBe('acct-hq');
      expect(sessionCalls(fetchSpy)).toHaveLength(1);
    });

    it('keeps the contact from/to filter on listThreads (real filtering, not the account workaround)', async () => {
      const fetchSpy = mockJmapFetch([SESSION]);
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      await client.listThreads('sales@unicorncommander.ai', 'jane@acme.test');
      const body = JSON.parse(fetchSpy.mock.calls[1][1].body as string);
      const query = body.methodCalls.find((c: any[]) => c[0] === 'Email/query')[1];
      expect(query.filter).toEqual({
        operator: 'OR',
        conditions: [{ from: 'jane@acme.test' }, { to: 'jane@acme.test' }],
      });
    });

    it('falls back to the primary accountId for an unknown address, after ONE session re-fetch', async () => {
      const fetchSpy = mockJmapFetch([SESSION]);
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      await client.listThreads('unknown@elsewhere.test', 'jane@acme.test');
      expect(accountIdOf(fetchSpy, 'Email/query', 0)).toBe('acct-hq');
      expect(sessionCalls(fetchSpy)).toHaveLength(2); // boot fetch + the one refresh

      // The same unknown address does NOT re-fetch again (no /session hammering).
      await client.listThreads('unknown@elsewhere.test', 'jane@acme.test');
      expect(accountIdOf(fetchSpy, 'Email/query', 1)).toBe('acct-hq');
      expect(sessionCalls(fetchSpy)).toHaveLength(2);
    });

    it('the one-time session refresh picks up a NEWLY granted delegation', async () => {
      const grown = {
        ...SESSION,
        accounts: { ...SESSION.accounts, 'acct-new': { name: 'new@unicorncommander.ai' } },
      };
      const fetchSpy = mockJmapFetch([SESSION, grown]);
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      await client.listThreads('new@unicorncommander.ai', 'jane@acme.test');
      expect(accountIdOf(fetchSpy, 'Email/query', 0)).toBe('acct-new');
      expect(sessionCalls(fetchSpy)).toHaveLength(2);
    });

    it('the JMAP send fallback (no Postmark) runs under the FROM mailbox\'s delegated account', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const body = JSON.parse(init.body as string);
        if (body.methodCalls.some((c: any[]) => c[0] === 'Identity/get')) {
          return jsonResponse({
            methodResponses: [
              ['Identity/get', { list: [{ id: 'ident-1', email: 'sales@unicorncommander.ai' }] }, '0'],
            ],
          });
        }
        return jsonResponse({
          methodResponses: [['Email/set', { created: { outbound: { id: 'em-1', threadId: 'th-1' } } }, '0']],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED)); // no POSTMARK_SERVER_TOKEN
      const r = await client.send(
        'sales@unicorncommander.ai',
        {
          fromAddress: 'sales@unicorncommander.ai',
          toAddress: 'jane@acme.test',
          subject: 's',
          body: 'b',
        },
        false,
      );
      expect(r).toMatchObject({ accepted: true, lane: 'james', providerMessageId: 'em-1' });
      expect(accountIdOf(fetchSpy, 'Identity/get')).toBe('acct-sales');
      expect(accountIdOf(fetchSpy, 'Email/set')).toBe('acct-sales');
      expect(accountIdOf(fetchSpy, 'EmailSubmission/set')).toBe('acct-sales');
    });
  });
});
