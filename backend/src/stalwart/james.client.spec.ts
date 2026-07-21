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
        if (body.methodCalls.some((c: any[]) => c[0] === 'Mailbox/query')) {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-sent-1'] }, '0']] });
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
      // The outbound Email/set MUST carry mailboxIds (RFC 8621 — James rejects a
      // create with none); this is the regression guard for the send-lane fix.
      const emailSet = JSON.parse(
        fetchSpy.mock.calls.find(([, i]: any) => i?.body && JSON.parse(i.body).methodCalls.some((c: any[]) => c[0] === 'Email/set'))[1].body,
      ).methodCalls.find((c: any[]) => c[0] === 'Email/set')[1];
      expect(emailSet.create.outbound.mailboxIds).toEqual({ 'mbx-sent-1': true });
    });

  });

  describe('webmail-wave additions', () => {
    const SESSION_WITH_BLOB = {
      ...SESSION,
      downloadUrl: 'https://james.example.test/download/{accountId}/{blobId}/{name}?accept={type}',
      uploadUrl: 'https://james.example.test/upload/{accountId}',
    };

    it('listFolderThreads resolves the role Mailbox, scopes Email/query to it, and maps hasAttachment/unread', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const body = JSON.parse((init as RequestInit).body as string);
        const methods = body.methodCalls.map((c: any[]) => c[0]);
        if (methods.length === 1 && methods[0] === 'Mailbox/query') {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-archive-1'] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [
            ['Email/query', { ids: ['em-1'], total: 1 }, '0'],
            [
              'Email/get',
              {
                list: [
                  {
                    id: 'em-1',
                    threadId: 'th-1',
                    subject: 'Hi',
                    from: [{ email: 'a@x.test' }],
                    to: [{ email: 'b@x.test' }],
                    receivedAt: '2026-01-01T00:00:00Z',
                    preview: 'hey',
                    keywords: {},
                    hasAttachment: true,
                  },
                ],
              },
              '1',
            ],
            ['Thread/get', { list: [{ id: 'th-1', emailIds: ['em-1'] }] }, '2'],
          ],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      const result = await client.listFolderThreads('sales@unicorncommander.ai', {
        folder: 'archive',
        limit: 20,
        offset: 0,
        query: 'invoice',
      });

      expect(result.threads).toHaveLength(1);
      expect(result.threads[0]).toMatchObject({ id: 'th-1', unread: true, hasAttachments: true });

      // The role resolved is 'archive' (the folder->role map), and the Email/query
      // filter combines the text search with inMailbox (search-v2 builder) — real filtering.
      const roleCall = JSON.parse(fetchSpy.mock.calls.find(([, init]: any) => {
        if (!init?.body) return false;
        const b = JSON.parse(init.body);
        return b.methodCalls.some((c: any[]) => c[0] === 'Mailbox/query');
      })[1].body).methodCalls.find((c: any[]) => c[0] === 'Mailbox/query')[1];
      expect(roleCall.filter).toEqual({ role: 'archive' });

      const queryCall = JSON.parse(fetchSpy.mock.calls.find(([, init]: any) => {
        if (!init?.body) return false;
        const b = JSON.parse(init.body);
        return b.methodCalls.some((c: any[]) => c[0] === 'Email/query');
      })[1].body).methodCalls.find((c: any[]) => c[0] === 'Email/query')[1];
      expect(queryCall.filter).toEqual({
        operator: 'AND',
        conditions: [{ text: 'invoice' }, { inMailbox: 'mbx-archive-1' }],
      });
      expect(queryCall.position).toBe(0);
      expect(queryCall.limit).toBe(20);
    });

    it('pollInbound baselines on the first poll (captures cursor, returns no backlog)', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const methods = JSON.parse((init as RequestInit).body as string).methodCalls.map((c: any[]) => c[0]);
        if (methods.length === 1 && methods[0] === 'Mailbox/query') {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-inbox-1'] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [
            ['Email/query', { ids: ['e1'], total: 1 }, '0'],
            [
              'Email/get',
              { list: [{ id: 'e1', threadId: 'th-1', subject: 'Hello', from: [{ email: 'a@acme.test' }], receivedAt: '2026-02-01T00:00:00Z' }] },
              '1',
            ],
          ],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      const res = await client.pollInbound('sales@unicorncommander.ai', null);
      expect(res).toEqual({ cursor: '2026-02-01T00:00:00Z', newMessages: [] });
    });

    it('pollInbound baselines an EMPTY inbox to a non-null cursor (so the first arrival is classified)', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const methods = JSON.parse((init as RequestInit).body as string).methodCalls.map((c: any[]) => c[0]);
        if (methods.length === 1 && methods[0] === 'Mailbox/query') {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-inbox-1'] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [
            ['Email/query', { ids: [], total: 0 }, '0'],
            ['Email/get', { list: [] }, '1'],
          ],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      const res = await client.pollInbound('sales@unicorncommander.ai', null);
      expect(res?.newMessages).toEqual([]);
      expect(res?.cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/); // a real ISO timestamp, not null
    });

    it('pollInbound returns only messages newer than the cursor, oldest-first', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const methods = JSON.parse((init as RequestInit).body as string).methodCalls.map((c: any[]) => c[0]);
        if (methods.length === 1 && methods[0] === 'Mailbox/query') {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-inbox-1'] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [
            ['Email/query', { ids: ['e3', 'e2', 'e1'], total: 3 }, '0'],
            [
              'Email/get',
              {
                list: [
                  { id: 'e3', threadId: 'th-3', subject: 'C', from: [{ email: 'c@x.test' }], receivedAt: '2026-02-03T00:00:00Z' },
                  { id: 'e2', threadId: 'th-2', subject: 'B', from: [{ email: 'b@x.test' }], to: [{ email: 'sales@unicorncommander.ai' }, { email: 'ops+lists@unicorncommander.ai' }], receivedAt: '2026-02-02T00:00:00Z' },
                  { id: 'e1', threadId: 'th-1', subject: 'A', from: [{ email: 'a@x.test' }], receivedAt: '2026-02-01T00:00:00Z' },
                ],
              },
              '1',
            ],
          ],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      const res = await client.pollInbound('sales@unicorncommander.ai', '2026-02-01T00:00:00Z');
      expect(res?.cursor).toBe('2026-02-03T00:00:00Z');
      expect(res?.newMessages.map((m) => m.threadId)).toEqual(['th-2', 'th-3']); // oldest-first, excludes the cursor msg
      expect(res?.newMessages[0]).toEqual({
        threadId: 'th-2',
        fromAddress: 'b@x.test',
        // The REAL To header rides along — the rules engine's 'to' conditions
        // match these, never the polled mailbox's own address as a stand-in.
        toAddresses: ['sales@unicorncommander.ai', 'ops+lists@unicorncommander.ai'],
        subject: 'B',
        receivedAt: '2026-02-02T00:00:00Z',
        // Wave 7: no X-UC-Agent-Autoreply header on the fixture → not an
        // agent auto-reply (the runtime's loop guard reads this flag).
        agentAutoreply: false,
      });
      // A message with no To header degrades to an empty list (header unknown).
      expect(res?.newMessages[1]?.toAddresses).toEqual([]);
    });

    it('pollInbound degrades to null when the inbox role has no mailbox', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        return jsonResponse({ methodResponses: [['Mailbox/query', { ids: [] }, '0']] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      expect(await client.pollInbound('sales@unicorncommander.ai', null)).toBeNull();
    });

    it('search-v2: parses operators (from:/subject:/has:attachment) into the JMAP filter', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const methods = JSON.parse((init as RequestInit).body as string).methodCalls.map(
          (c: any[]) => c[0],
        );
        if (methods.length === 1 && methods[0] === 'Mailbox/query') {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-inbox-1'] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [
            ['Email/query', { ids: [], total: 0 }, '0'],
            ['Email/get', { list: [] }, '1'],
            ['Thread/get', { list: [] }, '2'],
          ],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      await client.listFolderThreads('sales@unicorncommander.ai', {
        folder: 'inbox',
        limit: 20,
        offset: 0,
        query: 'from:alice@acme.test has:attachment invoice',
      });
      const queryCall = JSON.parse(
        fetchSpy.mock.calls.find(([, init]: any) => {
          if (!init?.body) return false;
          return JSON.parse(init.body).methodCalls.some((c: any[]) => c[0] === 'Email/query');
        })[1].body,
      ).methodCalls.find((c: any[]) => c[0] === 'Email/query')[1];
      expect(queryCall.filter).toEqual({
        operator: 'AND',
        conditions: [
          { text: 'invoice' },
          { from: 'alice@acme.test' },
          { hasAttachment: true },
          { inMailbox: 'mbx-inbox-1' },
        ],
      });
    });

    it('listFolderThreads degrades to { threads: [] } when the folder role has no Mailbox', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        return jsonResponse({ methodResponses: [['Mailbox/query', { ids: [] }, '0']] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      const result = await client.listFolderThreads('hq@unicorncommander.ai', {
        folder: 'spam',
        limit: 10,
        offset: 0,
      });
      expect(result).toEqual({ threads: [] });
    });

    it('getThreadDetail returns raw HTML/text bodies, cc, threading headers, read state, and attachments', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const body = JSON.parse((init as RequestInit).body as string);
        const methods = body.methodCalls.map((c: any[]) => c[0]);
        if (methods.includes('Thread/get') && !methods.includes('Email/get')) {
          return jsonResponse({ methodResponses: [['Thread/get', { list: [{ id: 'th-1', emailIds: ['em-1'] }] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [
            ['Thread/get', { list: [{ id: 'th-1', emailIds: ['em-1'] }] }, '0'],
            [
              'Email/get',
              {
                list: [
                  {
                    id: 'em-1',
                    threadId: 'th-1',
                    from: [{ email: 'a@x.test', name: 'A' }],
                    to: [{ email: 'b@x.test' }],
                    cc: [{ email: 'c@x.test' }],
                    subject: 'Hi',
                    receivedAt: '2026-01-01T00:00:00Z',
                    preview: 'hey',
                    keywords: { $seen: true },
                    messageId: ['abc@x.test'],
                    references: ['zzz@x.test'],
                    htmlBody: [{ partId: 'html' }],
                    textBody: [{ partId: 'text' }],
                    bodyValues: { html: { value: '<p>hi</p>' }, text: { value: 'hi' } },
                    attachments: [
                      { blobId: 'blob-1', name: 'f.pdf', type: 'application/pdf', size: 123, cid: null },
                    ],
                  },
                ],
              },
              '1',
            ],
          ],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      const [detail] = await client.getThreadDetail('hq@unicorncommander.ai', 'th-1');
      expect(detail).toMatchObject({
        id: 'em-1',
        htmlBody: '<p>hi</p>',
        textBody: 'hi',
        messageIdHeader: 'abc@x.test',
        references: ['zzz@x.test'],
        isUnread: false,
        cc: [{ address: 'c@x.test', name: null }],
        attachments: [{ blobId: 'blob-1', name: 'f.pdf', type: 'application/pdf', size: 123, cid: null }],
      });
    });

    it('setThreadRead patches $seen on every message in the thread (two-step: resolve ids, then Email/set)', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const body = JSON.parse((init as RequestInit).body as string);
        const methods = body.methodCalls.map((c: any[]) => c[0]);
        if (methods.includes('Thread/get')) {
          return jsonResponse({ methodResponses: [['Thread/get', { list: [{ id: 'th-1', emailIds: ['em-1', 'em-2'] }] }, '0']] });
        }
        return jsonResponse({ methodResponses: [['Email/set', { updated: { 'em-1': null, 'em-2': null } }, '0']] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      const ok = await client.setThreadRead('sales@unicorncommander.ai', 'th-1', true);
      expect(ok).toBe(true);

      const setCall = JSON.parse(fetchSpy.mock.calls.find(([, init]: any) => {
        if (!init?.body) return false;
        const b = JSON.parse(init.body);
        return b.methodCalls.some((c: any[]) => c[0] === 'Email/set');
      })[1].body).methodCalls.find((c: any[]) => c[0] === 'Email/set')[1];
      expect(setCall.update).toEqual({
        'em-1': { 'keywords/$seen': true },
        'em-2': { 'keywords/$seen': true },
      });
      expect(setCall.accountId).toBe('acct-sales');
    });

    it('setThreadRead degrades to false when the thread has no messages', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        return jsonResponse({ methodResponses: [['Thread/get', { list: [{ id: 'th-1', emailIds: [] }] }, '0']] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      expect(await client.setThreadRead('hq@unicorncommander.ai', 'th-1', false)).toBe(false);
    });

    it('getMailboxCounts reads unreadEmails/totalEmails off the role:inbox Mailbox', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const body = JSON.parse((init as RequestInit).body as string);
        const methods = body.methodCalls.map((c: any[]) => c[0]);
        if (methods.length === 1 && methods[0] === 'Mailbox/query') {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-inbox-1'] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [
            ['Mailbox/query', { ids: ['mbx-inbox-1'] }, '0'],
            ['Mailbox/get', { list: [{ id: 'mbx-inbox-1', role: 'inbox', unreadEmails: 5, totalEmails: 42 }] }, '1'],
          ],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      expect(await client.getMailboxCounts('hq@unicorncommander.ai')).toEqual({ inboxUnread: 5, inboxTotal: 42 });
    });

    it('getMailboxCounts degrades to null when there is no inbox Mailbox', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        return jsonResponse({ methodResponses: [['Mailbox/get', { list: [] }, '1']] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      expect(await client.getMailboxCounts('hq@unicorncommander.ai')).toBeNull();
    });

    it('downloadBlob fetches the session downloadUrl template, scoped to the mailbox account', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION_WITH_BLOB);
        if (String(url).startsWith('https://james.example.test/download/')) {
          return {
            ok: true,
            status: 200,
            headers: { get: (k: string) => (k === 'content-type' ? 'application/pdf' : null) },
            arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
          } as unknown as Response;
        }
        return jsonResponse({ methodResponses: [] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      const result = await client.downloadBlob('sales@unicorncommander.ai', 'blob-1');
      expect(result).not.toBeNull();
      expect(result?.data.toString()).toBe('hello');
      expect(result?.contentType).toBe('application/pdf');

      const downloadCall = fetchSpy.mock.calls.find(([u]: any) => String(u).startsWith('https://james.example.test/download/'));
      expect(downloadCall[0]).toBe('https://james.example.test/download/acct-sales/blob-1/attachment?accept=application%2Foctet-stream');
    });

    it('downloadBlob degrades to null when the engine has no downloadUrl template', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION); // no downloadUrl
        return jsonResponse({ methodResponses: [] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      expect(await client.downloadBlob('hq@unicorncommander.ai', 'blob-1')).toBeNull();
    });

    it('uploadBlob POSTs the file bytes to the session uploadUrl template and returns { blobId, type, size }', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION_WITH_BLOB);
        if (String(url).startsWith('https://james.example.test/upload/')) {
          expect((init as RequestInit).method).toBe('POST');
          expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'text/plain' });
          return jsonResponse({ accountId: 'acct-sales', blobId: 'blob-new', type: 'text/plain', size: 11 });
        }
        return jsonResponse({ methodResponses: [] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      const result = await client.uploadBlob('sales@unicorncommander.ai', Buffer.from('hello world'), 'text/plain', 'f.txt');
      expect(result).toEqual({ blobId: 'blob-new', type: 'text/plain', size: 11 });

      const uploadCall = fetchSpy.mock.calls.find(([u]: any) => String(u).startsWith('https://james.example.test/upload/'));
      expect(uploadCall[0]).toBe('https://james.example.test/upload/acct-sales');
    });

    it('getMessageHeaders resolves the real Message-ID + References for a reply built from an internal message id', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        return jsonResponse({
          methodResponses: [
            ['Email/get', { list: [{ id: 'em-orig', messageId: ['orig@x.test'], references: ['root@x.test'] }] }, '0'],
          ],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      const headers = await client.getMessageHeaders('hq@unicorncommander.ai', 'em-orig');
      expect(headers).toEqual({ messageIdHeader: 'orig@x.test', references: ['root@x.test'] });
    });

    it('getMessageHeaders degrades to null when the message is unknown', async () => {
      const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        return jsonResponse({ methodResponses: [['Email/get', { list: [] }, '0']] });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      expect(await client.getMessageHeaders('hq@unicorncommander.ai', 'unknown')).toBeNull();
    });

    it('routes an attachment-bearing send via JMAP EmailSubmission even when Postmark IS configured (attachments cannot cross the Postmark lane)', async () => {
      const CONFIGURED_WITH_POSTMARK = { ...CONFIGURED, POSTMARK_SERVER_TOKEN: 'pm-token' };
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        if (String(url).includes('postmarkapp.com')) {
          throw new Error('must not call Postmark for an attachment-bearing send');
        }
        const body = JSON.parse((init as RequestInit).body as string);
        if (body.methodCalls.some((c: any[]) => c[0] === 'Identity/get')) {
          return jsonResponse({
            methodResponses: [['Identity/get', { list: [{ id: 'ident-1', email: 'sales@unicorncommander.ai' }] }, '0']],
          });
        }
        if (body.methodCalls.some((c: any[]) => c[0] === 'Mailbox/query')) {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-sent-1'] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [['Email/set', { created: { outbound: { id: 'em-att-1', threadId: 'th-att-1' } } }, '0']],
        });
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED_WITH_POSTMARK));

      const r = await client.send(
        'sales@unicorncommander.ai',
        {
          fromAddress: 'sales@unicorncommander.ai',
          toAddress: 'jane@acme.test',
          subject: 's',
          body: 'b',
          attachments: [{ blobId: 'blob-1', name: 'f.pdf', type: 'application/pdf' }],
        },
        false,
      );
      expect(r).toMatchObject({ accepted: true, lane: 'james', providerMessageId: 'em-att-1' });

      // The Email/set create carried the attachment reference (the JMAP convenience property).
      const emailSetCall = JSON.parse(fetchSpy.mock.calls.find(([, i]: any) => {
        if (!i?.body) return false;
        const b = JSON.parse(i.body);
        return b.methodCalls.some((c: any[]) => c[0] === 'Email/set');
      })[1].body).methodCalls.find((c: any[]) => c[0] === 'Email/set')[1];
      expect(emailSetCall.create.outbound.attachments).toEqual([
        { blobId: 'blob-1', type: 'application/pdf', name: 'f.pdf' },
      ]);
    });

    it('FAILS LOUD on an attachment send when JMAP is unset — never silently drops the file', async () => {
      // JMAP dormant + Postmark configured + attachments present: the Postmark lane
      // cannot carry the blob, so send() must return accepted:false rather than send
      // WITHOUT the attachment (an accepted:true that dropped the file is worse).
      const client = new JamesClient(makeConfig({ POSTMARK_SERVER_TOKEN: 'pm-token' }));
      const r = await client.send(
        'sales@unicorncommander.ai',
        {
          fromAddress: 'sales@unicorncommander.ai',
          toAddress: 'jane@acme.test',
          subject: 's',
          body: 'b',
          attachments: [{ blobId: 'blob-1', name: 'f.pdf', type: 'application/pdf' }],
        },
        false,
      );
      expect(r.accepted).toBe(false);
      expect(r.reason).toMatch(/attachments require the JMAP lane/i);
    });

    it('a plain send (no attachments) still prefers Postmark when configured, carrying cc/bcc/in-reply-to/references', async () => {
      const CONFIGURED_WITH_POSTMARK = { ...CONFIGURED, POSTMARK_SERVER_TOKEN: 'pm-token' };
      let postmarkBody: any = null;
      const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        if (String(url).includes('postmarkapp.com')) {
          postmarkBody = JSON.parse((init as RequestInit).body as string);
          return jsonResponse({ MessageID: 'pm-123' });
        }
        throw new Error('must not call JMAP for a plain send when Postmark is configured');
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED_WITH_POSTMARK));

      const r = await client.send(
        'sales@unicorncommander.ai',
        {
          fromAddress: 'sales@unicorncommander.ai',
          toAddress: 'jane@acme.test',
          subject: 's',
          body: 'b',
          cc: ['cc@acme.test'],
          bcc: ['bcc@acme.test'],
          inReplyTo: 'orig@acme.test',
          references: ['orig@acme.test'],
        },
        false,
      );
      expect(r).toMatchObject({ accepted: true, lane: 'postmark', providerMessageId: 'pm-123' });
      expect(postmarkBody).toMatchObject({
        Cc: 'cc@acme.test',
        Bcc: 'bcc@acme.test',
        Headers: [
          { Name: 'In-Reply-To', Value: '<orig@acme.test>' },
          { Name: 'References', Value: '<orig@acme.test>' },
        ],
      });
    });

    it('toAddresses fans out to multiple recipients on BOTH the Postmark and JMAP send lanes', async () => {
      // Postmark lane: To is comma-joined.
      let postmarkBody: any = null;
      const postmarkFetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        if (String(url).includes('postmarkapp.com')) {
          postmarkBody = JSON.parse((init as RequestInit).body as string);
          return jsonResponse({ MessageID: 'pm-multi' });
        }
        throw new Error('unexpected JMAP call on the Postmark lane');
      });
      global.fetch = postmarkFetch as any;
      const postmarkClient = new JamesClient(makeConfig({ ...CONFIGURED, POSTMARK_SERVER_TOKEN: 'pm-token' }));
      await postmarkClient.send(
        'sales@unicorncommander.ai',
        {
          fromAddress: 'sales@unicorncommander.ai',
          toAddress: 'a@acme.test',
          toAddresses: ['a@acme.test', 'b@acme.test'],
          subject: 's',
          body: 'b',
        },
        false,
      );
      expect(postmarkBody.To).toBe('a@acme.test, b@acme.test');

      // JMAP lane (no Postmark): to is a proper array of EmailAddress objects.
      const jmapFetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/session')) return jsonResponse(SESSION);
        const body = JSON.parse((init as RequestInit).body as string);
        if (body.methodCalls.some((c: any[]) => c[0] === 'Identity/get')) {
          return jsonResponse({
            methodResponses: [['Identity/get', { list: [{ id: 'ident-1', email: 'sales@unicorncommander.ai' }] }, '0']],
          });
        }
        if (body.methodCalls.some((c: any[]) => c[0] === 'Mailbox/query')) {
          return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-sent-1'] }, '0']] });
        }
        return jsonResponse({
          methodResponses: [['Email/set', { created: { outbound: { id: 'em-multi', threadId: 'th-multi' } } }, '0']],
        });
      });
      global.fetch = jmapFetch as any;
      const jmapClient = new JamesClient(makeConfig(CONFIGURED));
      await jmapClient.send(
        'sales@unicorncommander.ai',
        {
          fromAddress: 'sales@unicorncommander.ai',
          toAddress: 'a@acme.test',
          toAddresses: ['a@acme.test', 'b@acme.test'],
          subject: 's',
          body: 'b',
        },
        false,
      );
      const emailSetCall = JSON.parse(jmapFetch.mock.calls.find(([, i]: any) => {
        if (!i?.body) return false;
        const b = JSON.parse(i.body);
        return b.methodCalls.some((c: any[]) => c[0] === 'Email/set');
      })[1].body).methodCalls.find((c: any[]) => c[0] === 'Email/set')[1];
      expect(emailSetCall.create.outbound.to).toEqual([{ email: 'a@acme.test' }, { email: 'b@acme.test' }]);
    });
  });
});
