import { ConfigService } from '@nestjs/config';
import { JamesClient } from './james.client';

/**
 * JamesClient folder CRUD — custom folders/labels over JMAP `Mailbox` objects.
 * Load-bearing here:
 *   (1) degrade-clean — JAMES_JMAP_URL unset ⇒ []/null/false with NO fetch;
 *   (2) role (system) folders are inviolable — deleteFolder REFUSES a non-null
 *       role and issues no destroy;
 *   (3) created/updated/destroyed plumbing maps to honest ids/booleans.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const SESSION = {
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-hq' },
  accounts: { 'acct-hq': { name: 'hq@unicorncommander.ai' } },
};

const CONFIGURED = {
  JAMES_JMAP_URL: 'https://james.example.test/jmap/',
  JAMES_JMAP_BASIC: 'hq@unicorncommander.ai:secret',
};

const MBX = 'hq@unicorncommander.ai';

interface FolderMockOpts {
  /** Mailbox/get with ids:null (listFolders) → this list. */
  allFolders?: any[];
  /** Mailbox/get with ids:[x] (delete probe) → this single folder (or none). */
  target?: any | null;
  /** Mailbox/set create → the created id (null ⇒ notCreated). */
  createdId?: string | null;
  /** Mailbox/set update → these ids appear in `updated`. */
  updatedIds?: string[];
  /** Mailbox/set destroy → these ids appear in `destroyed`. */
  destroyedIds?: string[];
}

/** GET /session serves the session; POST answers each Mailbox call from `opts`. */
function mockFolderFetch(opts: FolderMockOpts) {
  return jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/session')) return jsonResponse(SESSION);
    const body = JSON.parse((init!.body as string));
    const [method, args] = body.methodCalls[0];
    if (method === 'Mailbox/get') {
      // ids:null ⇒ list all (listFolders); ids:[x] ⇒ the single probed target.
      const list = args.ids == null ? (opts.allFolders ?? []) : opts.target ? [opts.target] : [];
      return jsonResponse({ methodResponses: [['Mailbox/get', { list }, '0']] });
    }
    if (method === 'Mailbox/set') {
      if (args.create) {
        const key = Object.keys(args.create)[0];
        return jsonResponse({
          methodResponses: [
            [
              'Mailbox/set',
              opts.createdId
                ? { created: { [key]: { id: opts.createdId } }, notCreated: {} }
                : { created: {}, notCreated: { [key]: { type: 'invalidProperties' } } },
              '0',
            ],
          ],
        });
      }
      if (args.update) {
        const updated: Record<string, unknown> = {};
        for (const id of opts.updatedIds ?? []) updated[id] = null;
        return jsonResponse({ methodResponses: [['Mailbox/set', { updated }, '0']] });
      }
      if (args.destroy) {
        return jsonResponse({ methodResponses: [['Mailbox/set', { destroyed: opts.destroyedIds ?? [] }, '0']] });
      }
    }
    return jsonResponse({ methodResponses: [] });
  });
}

/** The POSTed JMAP method calls (excludes the /session GETs). */
function postedMethods(fetchSpy: jest.Mock): string[] {
  return fetchSpy.mock.calls
    .filter(([u]) => !String(u).endsWith('/session'))
    .flatMap(([, init]) => JSON.parse((init as RequestInit).body as string).methodCalls as any[])
    .map((c) => c[0]);
}

/** The args object of the nth POSTed call to `method`. */
function argsOf(fetchSpy: jest.Mock, method: string, nth = 0): any {
  const calls = fetchSpy.mock.calls
    .filter(([u]) => !String(u).endsWith('/session'))
    .flatMap(([, init]) => JSON.parse((init as RequestInit).body as string).methodCalls as any[])
    .filter((c) => c[0] === method);
  return calls[nth]?.[1];
}

describe('JamesClient folder CRUD', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('degrade-clean: JAMES_JMAP_URL unset', () => {
    const client = new JamesClient(makeConfig({}));

    it('every folder method returns []/null/false WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listFolders(MBX)).resolves.toEqual([]);
      await expect(client.createFolder(MBX, 'Projects')).resolves.toBeNull();
      await expect(client.renameFolder(MBX, 'mbx-1', 'X')).resolves.toBe(false);
      await expect(client.deleteFolder(MBX, 'mbx-1')).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('listFolders', () => {
    it('maps system role folders AND custom folders to the folder shape', async () => {
      const fetchSpy = mockFolderFetch({
        allFolders: [
          { id: 'mbx-inbox', name: 'Inbox', role: 'inbox', parentId: null, unreadEmails: 3 },
          { id: 'mbx-proj', name: 'Projects', role: null, parentId: null },
          { id: 'mbx-sub', name: 'Q3', role: null, parentId: 'mbx-proj', unreadEmails: 0 },
        ],
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      const folders = await client.listFolders(MBX);
      expect(folders).toEqual([
        { id: 'mbx-inbox', name: 'Inbox', role: 'inbox', parentId: null, unread: 3 },
        { id: 'mbx-proj', name: 'Projects', role: null, parentId: null, unread: undefined },
        { id: 'mbx-sub', name: 'Q3', role: null, parentId: 'mbx-proj', unread: 0 },
      ]);
      // Asked the engine for ALL mailboxes (ids:null).
      expect(argsOf(fetchSpy, 'Mailbox/get').ids).toBeNull();
    });
  });

  describe('createFolder', () => {
    it('returns the created id and posts a role:null create', async () => {
      const fetchSpy = mockFolderFetch({ createdId: 'mbx-new' });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      await expect(client.createFolder(MBX, 'Projects')).resolves.toEqual({ id: 'mbx-new' });
      const create = argsOf(fetchSpy, 'Mailbox/set').create;
      const created = create[Object.keys(create)[0]];
      expect(created).toMatchObject({ name: 'Projects', role: null });
      expect(created.parentId).toBeUndefined();
    });

    it('carries parentId when nesting', async () => {
      const fetchSpy = mockFolderFetch({ createdId: 'mbx-child' });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      await client.createFolder(MBX, 'Q3', 'mbx-proj');
      const create = argsOf(fetchSpy, 'Mailbox/set').create;
      expect(create[Object.keys(create)[0]].parentId).toBe('mbx-proj');
    });

    it('returns null when the engine does not create it', async () => {
      const fetchSpy = mockFolderFetch({ createdId: null });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      await expect(client.createFolder(MBX, 'Projects')).resolves.toBeNull();
    });
  });

  describe('renameFolder', () => {
    it('is true when the engine reports the id updated', async () => {
      const fetchSpy = mockFolderFetch({ updatedIds: ['mbx-proj'] });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      await expect(client.renameFolder(MBX, 'mbx-proj', 'Archive 2026')).resolves.toBe(true);
      expect(argsOf(fetchSpy, 'Mailbox/set').update['mbx-proj']).toEqual({ name: 'Archive 2026' });
    });

    it('is false when the id is not in the updated set', async () => {
      const fetchSpy = mockFolderFetch({ updatedIds: [] });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      await expect(client.renameFolder(MBX, 'mbx-proj', 'X')).resolves.toBe(false);
    });
  });

  describe('deleteFolder', () => {
    it('REFUSES a role (system) folder — returns false and issues NO destroy', async () => {
      const fetchSpy = mockFolderFetch({ target: { id: 'mbx-inbox', role: 'inbox' } });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      await expect(client.deleteFolder(MBX, 'mbx-inbox')).resolves.toBe(false);
      // Probed the role, but never asked the engine to destroy anything.
      expect(postedMethods(fetchSpy)).toContain('Mailbox/get');
      expect(argsOf(fetchSpy, 'Mailbox/set')).toBeUndefined();
    });

    it('destroys a custom (role:null) folder and confirms it', async () => {
      const fetchSpy = mockFolderFetch({
        target: { id: 'mbx-proj', role: null },
        destroyedIds: ['mbx-proj'],
      });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));

      await expect(client.deleteFolder(MBX, 'mbx-proj')).resolves.toBe(true);
      expect(argsOf(fetchSpy, 'Mailbox/set').destroy).toEqual(['mbx-proj']);
    });

    it('is false when the destroy is not confirmed by the engine', async () => {
      const fetchSpy = mockFolderFetch({ target: { id: 'mbx-proj', role: null }, destroyedIds: [] });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      await expect(client.deleteFolder(MBX, 'mbx-proj')).resolves.toBe(false);
    });

    it('is false (no destroy) when the folder is unknown to the mailbox', async () => {
      const fetchSpy = mockFolderFetch({ target: null });
      global.fetch = fetchSpy as any;
      const client = new JamesClient(makeConfig(CONFIGURED));
      await expect(client.deleteFolder(MBX, 'ghost')).resolves.toBe(false);
      expect(argsOf(fetchSpy, 'Mailbox/set')).toBeUndefined();
    });
  });
});

describe('JamesClient moveThreadToMailbox (move into a custom folder)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  it('degrades to false with NO fetch when unconfigured', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig({}));
    await expect(client.moveThreadToMailbox(MBX, 'th-1', 'mbx-proj')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates the target exists, then sets mailboxIds to exactly the target on every message', async () => {
    const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/session')) return jsonResponse(SESSION);
      const methods = JSON.parse((init!.body as string)).methodCalls.map((c: any[]) => c[0]);
      if (methods.includes('Mailbox/get')) {
        return jsonResponse({ methodResponses: [['Mailbox/get', { list: [{ id: 'mbx-proj' }] }, '0']] });
      }
      if (methods.includes('Thread/get')) {
        return jsonResponse({ methodResponses: [['Thread/get', { list: [{ id: 'th-1', emailIds: ['em-1', 'em-2'] }] }, '0']] });
      }
      return jsonResponse({ methodResponses: [['Email/set', { updated: { 'em-1': null, 'em-2': null } }, '0']] });
    });
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    await expect(client.moveThreadToMailbox(MBX, 'th-1', 'mbx-proj')).resolves.toBe(true);
    const setBody = fetchSpy.mock.calls.find(([, i]: any) => i?.body && JSON.parse(i.body).methodCalls.some((c: any[]) => c[0] === 'Email/set'));
    const update = JSON.parse(setBody![1].body as string).methodCalls.find((c: any[]) => c[0] === 'Email/set')[1].update;
    expect(update).toEqual({
      'em-1': { mailboxIds: { 'mbx-proj': true } },
      'em-2': { mailboxIds: { 'mbx-proj': true } },
    });
  });

  it('REFUSES an unknown target — returns false and issues no Email/set', async () => {
    const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith('/session')) return jsonResponse(SESSION);
      // Target probe returns nothing → the id is not a real mailbox in this account.
      return jsonResponse({ methodResponses: [['Mailbox/get', { list: [] }, '0']] });
    });
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    await expect(client.moveThreadToMailbox(MBX, 'th-1', 'ghost')).resolves.toBe(false);
    const sawEmailSet = fetchSpy.mock.calls.some(([, i]: any) => i?.body && JSON.parse(i.body).methodCalls.some((c: any[]) => c[0] === 'Email/set'));
    expect(sawEmailSet).toBe(false);
  });

  it('is false when the thread has no messages (nothing to move)', async () => {
    const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/session')) return jsonResponse(SESSION);
      const methods = JSON.parse((init!.body as string)).methodCalls.map((c: any[]) => c[0]);
      if (methods.includes('Mailbox/get')) {
        return jsonResponse({ methodResponses: [['Mailbox/get', { list: [{ id: 'mbx-proj' }] }, '0']] });
      }
      return jsonResponse({ methodResponses: [['Thread/get', { list: [{ id: 'th-1', emailIds: [] }] }, '0']] });
    });
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));
    await expect(client.moveThreadToMailbox(MBX, 'th-1', 'mbx-proj')).resolves.toBe(false);
  });
});

describe('JamesClient listFolderThreads with an explicit custom-folder id', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  it('scopes the Email/query straight to the custom mailbox id (no role Mailbox/query)', async () => {
    const fetchSpy = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith('/session')) return jsonResponse(SESSION);
      return jsonResponse({
        methodResponses: [
          ['Email/query', { ids: ['em-1'], total: 1 }, '0'],
          ['Email/get', { list: [{ id: 'em-1', threadId: 'th-1', subject: 'In Projects', from: [{ email: 'a@x.test' }], receivedAt: '2026-07-17T00:00:00Z', keywords: { $seen: true } }] }, '1'],
          ['Thread/get', { list: [{ id: 'th-1', emailIds: ['em-1'] }] }, '2'],
        ],
      });
    });
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    const result = await client.listFolderThreads('hq@unicorncommander.ai', {
      folder: 'inbox',
      limit: 50,
      offset: 0,
      query: null,
      mailboxId: 'mbx-proj',
    });
    expect(result.threads.map((t) => t.id)).toEqual(['th-1']);
    // The role path was skipped — no Mailbox/query was posted at all.
    const postedMethodNames = fetchSpy.mock.calls
      .filter(([u]: any) => !String(u).endsWith('/session'))
      .flatMap(([, i]: any) => JSON.parse(i.body).methodCalls.map((c: any[]) => c[0]));
    expect(postedMethodNames).not.toContain('Mailbox/query');
    // The Email/query filter is scoped to the given custom mailbox id.
    const queryArgs = JSON.parse(fetchSpy.mock.calls.find(([u]: any) => !String(u).endsWith('/session'))![1].body as string)
      .methodCalls.find((c: any[]) => c[0] === 'Email/query')[1];
    expect(queryArgs.filter.inMailbox).toBe('mbx-proj');
  });
});
