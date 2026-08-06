import { ConfigService } from '@nestjs/config';
import { JamesAdminClient } from './james-admin.client';
import { DEFAULT_MAILBOX_QUOTA_BYTES } from './mail-engine-admin.constants';

/**
 * JamesAdminClient is the degrade-clean mail-engine ADMIN adapter (James
 * WebAdmin). The load-bearing guarantee: with JAMES_WEBADMIN_URL unset it is
 * fully dormant — every mutation reports provisioned:false and every list
 * returns [] WITHOUT a network call, and nothing throws. When configured it
 * drives the WebAdmin REST surface (PUT /domains, PUT /users, /quota, /address).
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function statusResponse(status = 204, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as unknown as Response;
}

describe('JamesAdminClient', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('degrade-clean: JAMES_WEBADMIN_URL unset (dormant)', () => {
    const client = new JamesAdminClient(makeConfig({}));

    it('isConfigured() is false', () => {
      expect(client.isConfigured()).toBe(false);
    });

    it('mutations report provisioned:false WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.ensureDomain('acme.test')).resolves.toMatchObject({ provisioned: false });
      await expect(client.ensureAccount('a@acme.test')).resolves.toMatchObject({ provisioned: false });
      await expect(client.setQuota('a@acme.test', 1024)).resolves.toMatchObject({ provisioned: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('lists return [] WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listDomains()).resolves.toEqual([]);
      await expect(client.listAccounts()).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('configured: WebAdmin REST', () => {
    const CONFIGURED = { JAMES_WEBADMIN_URL: 'http://james.test:8000/' };

    it('isConfigured() is true', () => {
      expect(new JamesAdminClient(makeConfig(CONFIGURED)).isConfigured()).toBe(true);
    });

    it('ensureDomain PUTs /domains/{domain} and reports provisioned', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(statusResponse(204));
      global.fetch = fetchSpy as any;
      const client = new JamesAdminClient(makeConfig(CONFIGURED));
      const r = await client.ensureDomain('acme.test');
      expect(r.provisioned).toBe(true);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://james.test:8000/domains/acme.test');
      expect(init.method).toBe('PUT');
    });

    it('ensureDomain treats a 409 (already exists) as idempotent success', async () => {
      global.fetch = jest.fn().mockResolvedValue(statusResponse(409)) as any;
      const client = new JamesAdminClient(makeConfig(CONFIGURED));
      await expect(client.ensureDomain('acme.test')).resolves.toMatchObject({ provisioned: true });
    });

    it('ensureAccount ensures the domain, creates the user with a password, and provisions', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(statusResponse(204));
      global.fetch = fetchSpy as any;
      const client = new JamesAdminClient(makeConfig(CONFIGURED));
      const r = await client.ensureAccount('alice@acme.test', { quotaBytes: 1073741824 });
      expect(r.provisioned).toBe(true);

      const calls = fetchSpy.mock.calls.map((c) => ({ url: c[0] as string, init: c[1] as RequestInit }));
      // domain ensured first
      expect(calls.some((c) => c.url.endsWith('/domains/acme.test'))).toBe(true);
      // user created with a password body
      const userCall = calls.find((c) => /\/users\/alice%40acme\.test$/.test(c.url));
      expect(userCall).toBeDefined();
      expect(userCall!.init.method).toBe('PUT');
      expect(JSON.parse(userCall!.init.body as string)).toHaveProperty('password');
      // standard mailboxes pre-created
      expect(calls.some((c) => /\/mailboxes\/INBOX$/.test(c.url))).toBe(true);
      // quota applied as a raw integer body
      const quotaCall = calls.find((c) => /\/quota\/users\/.+\/size$/.test(c.url));
      expect(quotaCall!.init.body).toBe('1073741824');
    });

    it('ensureAccount applies the 5 GiB default quota when none is specified', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(statusResponse(204));
      global.fetch = fetchSpy as any;
      const client = new JamesAdminClient(makeConfig(CONFIGURED));

      await expect(client.ensureAccount('alice@acme.test')).resolves.toMatchObject({
        provisioned: true,
      });

      const quotaCall = fetchSpy.mock.calls.find((call) =>
        /\/quota\/users\/.+\/size$/.test(call[0] as string),
      );
      expect(quotaCall?.[1].body).toBe(String(DEFAULT_MAILBOX_QUOTA_BYTES));
    });

    it('listDomains maps the string array', async () => {
      global.fetch = jest.fn().mockResolvedValue(statusResponse(200, ['a.test', 'b.test'])) as any;
      const client = new JamesAdminClient(makeConfig(CONFIGURED));
      await expect(client.listDomains()).resolves.toEqual([{ domain: 'a.test' }, { domain: 'b.test' }]);
    });

    it('listAccounts maps the {username} array to addresses', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(statusResponse(200, [{ username: 'a@x.test' }, { username: 'b@x.test' }])) as any;
      const client = new JamesAdminClient(makeConfig(CONFIGURED));
      await expect(client.listAccounts()).resolves.toEqual([{ address: 'a@x.test' }, { address: 'b@x.test' }]);
    });

    it('reports provisioned:false (never throws) on a transport error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new JamesAdminClient(makeConfig(CONFIGURED));
      await expect(client.ensureDomain('acme.test')).resolves.toMatchObject({ provisioned: false });
    });
  });
});
