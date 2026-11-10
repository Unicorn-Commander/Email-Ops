import { ConfigService } from '@nestjs/config';
import { CleanerEngineClient } from './connected-accounts.client';

/**
 * Mail-thread reads must classify empty vs unavailable without echoing the
 * engine error body (it can contain a provider token).
 */
function make(
  env: Record<string, string | undefined> = {
    CLEANER_ENGINE_URL: 'http://engine.example.com',
    CLEANER_ENGINE_TOKEN: 'engine-secret',
  },
) {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return new CleanerEngineClient(config);
}

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('CleanerEngineClient mail-thread reads (empty vs unavailable)', () => {
  const creds = { token: 'user-access-token' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('engine_not_configured when URL/token are missing — never fetches', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('Network is forbidden in this test');
    });
    const client = make({ CLEANER_ENGINE_URL: '  ', CLEANER_ENGINE_TOKEN: undefined });
    const out = await client.listMailThreads('gmail', creds, 'inbox', 50);
    expect(out).toMatchObject({ threads: [], status: 'engine_not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('engine_unreachable on transport failure', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED token=nope'));
    const out = await make().listMailThreads('gmail', creds, 'inbox', 50);
    expect(out).toMatchObject({ threads: [], status: 'engine_unreachable' });
    expect(JSON.stringify(out)).not.toMatch(/user-access-token|engine-secret|nope/i);
  });

  it('engine_unreachable on HTTP 5xx — does not forward the error body', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonRes(502, { error: 'upstream token=secret-xyz' }));
    const out = await make().listMailThreads('gmail', creds, 'inbox', 50);
    expect(out).toMatchObject({ threads: [], status: 'engine_unreachable' });
    expect(JSON.stringify(out)).not.toMatch(/secret-xyz|token=/i);
  });

  it('engine_unreachable on HTTP 401 (engine token rejected)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonRes(401, { detail: 'Unauthorized' }));
    const out = await make().listMailThreads('gmail', creds, 'inbox', 50);
    expect(out).toMatchObject({ status: 'engine_unreachable' });
  });

  it('provider_error on HTTP 4xx from the engine', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonRes(400, { error: 'invalid mailbox token=abc' }));
    const out = await make().listMailThreads('gmail', creds, 'inbox', 50);
    expect(out).toMatchObject({ threads: [], status: 'provider_error' });
    expect(JSON.stringify(out)).not.toMatch(/token=abc/i);
  });

  it('passes through a successful empty mailbox (status ok)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonRes(200, { threads: [], next_page_token: null, has_more: false, status: 'ok' }),
    );
    const out = await make().listMailThreads('gmail', creds, 'inbox', 50);
    expect(out).toMatchObject({ threads: [], status: 'ok' });
  });

  it('passes through engine-typed provider_auth_failed without rewriting it', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonRes(200, { threads: [], status: 'provider_auth_failed' }),
    );
    const out = await make().listMailThreads('gmail', creds, 'inbox', 50);
    expect(out).toMatchObject({ threads: [], status: 'provider_auth_failed' });
  });

  it('getMailThread classifies the same statuses', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'));
    const out = await make().getMailThread('microsoft', { access_token: 'mtok' }, 't1');
    expect(out).toEqual({ messages: [], status: 'engine_unreachable' });
  });
});
