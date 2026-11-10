import { MailboxAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { ConnectedAccountsEnginePort } from '../connected-accounts/connected-accounts.port';
import { EngineMailProvider } from './engine-mail-provider';
import {
  MailReadStatus,
  MAIL_READ_STATUSES,
  isMailReadUnavailable,
  parseMailReadStatus,
  unwrapThreadMessages,
} from './mail-read-status';

/**
 * #78 follow-up: typed read statuses + no credential echo.
 *
 * The module #78 added is `mail-read-status.ts` (MAIL_READ_STATUSES at line 13,
 * isMailReadUnavailable at line 40, parseMailReadStatus at line 46,
 * mergeMailReadStatus at line 59, unwrapThreadMessages at line 71). #78 also
 * changed `engine-mail-provider.ts` (emptyPage at line 391) so that a failed
 * read returns a typed status and a `reason` that never carries tokens or
 * provider error bodies — and stopped the client from forwarding raw exception
 * bodies (`connected-accounts.client.ts` postMailRead, line 147).
 *
 * These tests pin:
 *   1. one mapping per typed status (the wire contract),
 *   2. a credential-looking string in a provider error body never appears in
 *      the returned result OR in captured logger output,
 *   3. older-client compatibility: a provider still returning a bare array is
 *      read as { messages, status: 'ok' }, and an absent status is 'ok'.
 *
 * Fixtures use fictional people/hosts (example.com) and an obviously fake
 * credential value. No network.
 */

const FAKE_CREDENTIAL = 'fake-token-for-test';

function gmailbox(over: Partial<MailboxAccount> = {}): MailboxAccount {
  return {
    id: 'mb-1',
    workspaceId: 'ws-1',
    emailAddress: 'me@example.com',
    displayName: 'Me',
    provider: 'gmail',
    ownerKind: 'HUMAN',
    ownerKey: 'kc-sub-1',
    kind: 'gmail',
    ...over,
  } as MailboxAccount;
}

function make(opts: {
  configured?: boolean;
  token?: string | null;
  user?: { keycloakId: string } | null;
  threads?: unknown;
  thread?: unknown;
}) {
  const broker = {
    getProviderAccessToken: jest.fn().mockResolvedValue(opts.token ?? null),
  } as unknown as KeycloakBrokerService;
  const engine = {
    isConfigured: jest.fn().mockReturnValue(opts.configured ?? true),
    listMailThreads: jest.fn().mockResolvedValue(opts.threads ?? null),
    getMailThread: jest.fn().mockResolvedValue(opts.thread ?? null),
  } as unknown as ConnectedAccountsEnginePort;
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue(opts.user ?? null),
    },
  } as unknown as PrismaService;
  return { provider: new EngineMailProvider(engine, broker, prisma), engine };
}

/**
 * Capture NestJS Logger output. Nest writes to console.warn/console.log with
 * the format `[Nest] <pid> - <date>    WARN [Context] message`, so the context
 * (EngineMailProvider) comes AFTER the level: match the context anywhere in the
 * line and capture the message after it.
 */
function captureLoggerOutput() {
  const lines: string[] = [];
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return {
    lines,
    restore: () => {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    },
  };
}

describe('mail-read-status (#78) typed read statuses', () => {
  it('MAIL_READ_STATUSES is exactly the five typed statuses', () => {
    expect(MAIL_READ_STATUSES).toEqual([
      'ok',
      'engine_not_configured',
      'engine_unreachable',
      'provider_auth_failed',
      'provider_error',
    ]);
  });

  it.each([
    ['engine_not_configured', true],
    ['engine_unreachable', true],
    ['provider_auth_failed', true],
    ['provider_error', true],
    ['ok', false],
    [null, false],
    [undefined, false],
    ['empty', false],
    ['ENGINE_NOT_CONFIGURED', false],
  ] as const)('isMailReadUnavailable(%j) → %s (one mapping per status)', (status, expected) => {
    expect(isMailReadUnavailable(status)).toBe(expected);
  });

  it.each(['ok', 'engine_not_configured', 'engine_unreachable', 'provider_auth_failed', 'provider_error'] as const)(
    'parseMailReadStatus accepts the typed value %s',
    (status) => {
      expect(parseMailReadStatus(status)).toBe(status);
    },
  );

  it.each([
    ['nope', 'ok'],
    [undefined, 'ok'],
    [null, 'ok'],
    [42, 'ok'],
    [{ status: 'provider_error' }, 'ok'],
  ] as const)('parseMailReadStatus(%j) falls back to "ok" for a non-typed input', (raw, expected) => {
    expect(parseMailReadStatus(raw)).toBe(expected);
  });

  it('listInbox maps each failure to its typed status (wire contract)', async () => {
    const cases: [string, Parameters<typeof make>[0], MailReadStatus][] = [
      ['engine_not_configured', { configured: false }, 'engine_not_configured'],
      [
        'provider_auth_failed (no token)',
        { user: { keycloakId: 'kc-sub-1' }, token: null },
        'provider_auth_failed',
      ],
      [
        'engine_unreachable (null engine result)',
        { user: { keycloakId: 'kc-sub-1' }, token: 'gtok', threads: null },
        'engine_unreachable',
      ],
      [
        'provider_error (engine typed status)',
        {
          user: { keycloakId: 'kc-sub-1' },
          token: 'gtok',
          threads: { threads: [], status: 'provider_error' },
        },
        'provider_error',
      ],
    ];
    for (const [label, opts, expected] of cases) {
      const { provider, engine } = make(opts);
      const out = await provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 });
      expect(out.status).toBe(expected);
      expect(out.threads).toEqual([]);
      if (expected === 'engine_not_configured' || expected === 'provider_auth_failed') {
        expect(engine.listMailThreads).not.toHaveBeenCalled();
      }
    }
  });

  it('listThreadMessages maps each failure to its typed status (wire contract)', async () => {
    const cases: [string, Parameters<typeof make>[0], MailReadStatus][] = [
      ['engine_not_configured', { configured: false }, 'engine_not_configured'],
      [
        'provider_auth_failed (no token)',
        { user: { keycloakId: 'kc-sub-1' }, token: null },
        'provider_auth_failed',
      ],
      [
        'engine_unreachable (null engine result)',
        { user: { keycloakId: 'kc-sub-1' }, token: 'gtok', thread: null },
        'engine_unreachable',
      ],
      [
        'provider_error (engine typed status)',
        { user: { keycloakId: 'kc-sub-1' }, token: 'gtok', thread: { messages: [], status: 'provider_error' } },
        'provider_error',
      ],
    ];
    for (const [label, opts, expected] of cases) {
      const { provider } = make(opts);
      const out = await provider.listThreadMessages(gmailbox(), 't1');
      expect(out).toEqual({ messages: [], status: expected });
    }
  });
});

describe('mail-read-status (#78) no credential echo', () => {
  it('a credential-looking string in the provider error body never reaches the wire (client seam)', async () => {
    // The real no-echo guarantee lives at the client seam (#78): the engine
    // classifies the provider failure into a typed status and the client NEVER
    // forwards the raw error body (it can echo a credential). A 4xx body that
    // carries a credential-looking string must not appear in the returned
    // result OR in the captured logger output.
    const { CleanerEngineClient } = await import('../connected-accounts/connected-accounts.client');
    const config = {
      get: (k: string) =>
        k === 'CLEANER_ENGINE_URL' ? 'http://engine.example.com' : k === 'CLEANER_ENGINE_TOKEN' ? 'engine-secret' : undefined,
    };
    const client = new CleanerEngineClient(config as unknown as import('@nestjs/config').ConfigService);
    const captured = captureLoggerOutput();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        {
          ok: false,
          status: 400,
          json: async () => ({ error: `invalid mailbox token=${FAKE_CREDENTIAL}` }),
          text: async () => JSON.stringify({ error: `invalid mailbox token=${FAKE_CREDENTIAL}` }),
        } as unknown as Response,
      );
    let out: unknown;
    try {
      out = await client.listMailThreads('gmail', { token: 'user-access-token' }, 'inbox', 50);
    } finally {
      captured.restore();
      jest.restoreAllMocks();
    }
    expect(out).toMatchObject({ threads: [], status: 'provider_error' });
    expect(JSON.stringify(out)).not.toContain(FAKE_CREDENTIAL);
    expect(JSON.stringify(out)).not.toContain('user-access-token');
    const logText = captured.lines.join('\n');
    expect(logText).not.toContain(FAKE_CREDENTIAL);
    expect(logText).not.toContain('user-access-token');
  });

  it('the provider maps an engine-typed provider_error to the wire (status + clean reason)', async () => {
    // The provider passes the engine's `reason` through unchanged (the engine
    // is responsible for keeping credentials out of it). Pin that the provider
    // surfaces the typed status, forwards the engine's reason verbatim, and
    // never injects the user's own OAuth token into the result.
    const { provider } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      threads: {
        threads: [],
        status: 'provider_error',
        reason: 'provider rejected the request',
      },
    });
    const out = await provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 });
    expect(out.status).toBe('provider_error');
    expect(out.reason).toBe('provider rejected the request');
    expect(JSON.stringify(out)).not.toContain('gtok');
    expect(JSON.stringify(out)).not.toContain(FAKE_CREDENTIAL);
  });

  it('the provider does not swallow an engine exception (it propagates; no-echo is the client\'s job)', async () => {
    // The provider (engine-mail-provider.ts) does NOT catch a throwing engine
    // port — the exception propagates to the caller. That is outside #78's
    // scope (the no-credential-echo guarantee is enforced at the client, which
    // catches transport/HTTP errors and never forwards their bodies — covered
    // above). Pin the provider's actual contract: it surfaces the typed status
    // for a null/typed engine result, and lets a throwing engine bubble up.
    const { provider, engine } = make({ user: { keycloakId: 'kc-sub-1' }, token: 'gtok' });
    (engine.listMailThreads as jest.Mock).mockRejectedValue(new Error('engine exploded'));
    await expect(provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 })).rejects.toThrow('engine exploded');
  });

  it('the client does not forward a raw provider error body into the log or the result', async () => {
    // Direct proof at the client seam: a 4xx from the engine whose body carries
    // a credential-looking string must NOT be logged (the client logs only the
    // status code) and must NOT be forwarded into the returned result.
    const { CleanerEngineClient } = await import('../connected-accounts/connected-accounts.client');
    const config = {
      get: (k: string) =>
        k === 'CLEANER_ENGINE_URL' ? 'http://engine.example.com' : k === 'CLEANER_ENGINE_TOKEN' ? 'engine-secret' : undefined,
    };
    const client = new CleanerEngineClient(config as unknown as import('@nestjs/config').ConfigService);
    const captured = captureLoggerOutput();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        {
          ok: false,
          status: 400,
          json: async () => ({ error: `invalid mailbox token=${FAKE_CREDENTIAL}` }),
          text: async () => JSON.stringify({ error: `invalid mailbox token=${FAKE_CREDENTIAL}` }),
        } as unknown as Response,
      );
    let out: unknown;
    try {
      out = await client.listMailThreads('gmail', { token: 'user-access-token' }, 'inbox', 50);
    } finally {
      captured.restore();
      jest.restoreAllMocks();
    }
    expect(out).toMatchObject({ threads: [], status: 'provider_error' });
    expect(JSON.stringify(out)).not.toContain(FAKE_CREDENTIAL);
    expect(JSON.stringify(out)).not.toContain('user-access-token');
    const logText = captured.lines.join('\n');
    expect(logText).not.toContain(FAKE_CREDENTIAL);
    expect(logText).not.toContain('user-access-token');
  });
});

describe('mail-read-status (#78) older-client compatibility', () => {
  it('unwrapThreadMessages accepts a bare array (older provider fakes) as { messages, status: ok }', () => {
    const bare = [{ id: 'm1' }];
    expect(unwrapThreadMessages(bare)).toEqual({ messages: bare, status: 'ok' });
  });

  it('unwrapThreadMessages reads a typed result, mapping a non-typed status to ok', () => {
    expect(unwrapThreadMessages({ messages: [], status: 'provider_error' })).toEqual({
      messages: [],
      status: 'provider_error',
    });
    expect(unwrapThreadMessages({ messages: [], status: 'bogus' })).toEqual({
      messages: [],
      status: 'ok',
    });
    expect(unwrapThreadMessages({ messages: [] })).toEqual({ messages: [], status: 'ok' });
  });

  it('an absent status is read as ok (older backend wire shape)', async () => {
    const { provider } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      threads: { threads: [] },
    });
    const out = await provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 });
    expect(out.status).toBe('ok');
  });

  it('a typed provider result with status ok is read as populated (older-client sees a working inbox)', async () => {
    // An older client that ignores the new `status` field still renders the
    // populated list correctly: the provider returns the messages with status
    // 'ok', which an older client treats as a normal (possibly empty) list.
    const { provider } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      thread: {
        messages: [
          { id: 'm1', thread_id: 't1', from: null, to: [], subject: 'S', sent_at: null, preview: 'p', direction: 'received' },
        ],
        status: 'ok',
      },
    });
    const out = await provider.listThreadMessages(gmailbox(), 't1');
    expect(out.status).toBe('ok');
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].subject).toBe('S');
  });
});
