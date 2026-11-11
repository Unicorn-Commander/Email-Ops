import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { encrypt } from '../connected-accounts/crypto';
import { AuthService } from './auth.service';
import { KeycloakBrokerService } from './keycloak-broker.service';

const KEY = Buffer.alloc(32, 23).toString('base64');

describe('KeycloakBrokerService', () => {
  const prev = {
    CONNECTED_ACCOUNT_ENC_KEY: process.env.CONNECTED_ACCOUNT_ENC_KEY,
    KEYCLOAK_URL: process.env.KEYCLOAK_URL,
    KEYCLOAK_REALM: process.env.KEYCLOAK_REALM,
    KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
    KEYCLOAK_CLIENT_SECRET: process.env.KEYCLOAK_CLIENT_SECRET,
    KEYCLOAK_TIMEOUT_MS: process.env.KEYCLOAK_TIMEOUT_MS,
  };

  const authService = {
    storeKcRefreshToken: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthService;

  const config = {
    get: (key: string, fallback?: string) => {
      const value = process.env[key];
      return value === undefined ? fallback : value;
    },
  } as unknown as ConfigService;

  beforeEach(() => {
    process.env.CONNECTED_ACCOUNT_ENC_KEY = KEY;
    process.env.KEYCLOAK_URL = 'https://auth.example.test';
    process.env.KEYCLOAK_REALM = 'uchub';
    process.env.KEYCLOAK_CLIENT_ID = 'email-ops';
    process.env.KEYCLOAK_CLIENT_SECRET = 'client-secret';
    process.env.KEYCLOAK_TIMEOUT_MS = '1000';
    process.env.JEST_WORKER_ID = process.env.JEST_WORKER_ID || '1';
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function makeService() {
    return new KeycloakBrokerService(config, authService);
  }

  function makeUser(): User {
    return {
      id: 'u1',
      kcRefreshTokenEnc: encrypt({ refresh_token: 'kc-refresh-token' }),
    } as User;
  }

  function refreshResponse(body: Record<string, unknown>) {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  }

  function okTextResponse(body: string) {
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('json not expected');
      },
      text: async () => body,
    } as any;
  }

  it('returns null when the user has no stored refresh token', async () => {
    const svc = makeService();
    await expect(
      svc.getProviderAccessToken({ id: 'u1', kcRefreshTokenEnc: null } as User, 'google'),
    ).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refreshes the KC token, re-stores rotated refresh tokens, and fetches the broker token', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        refreshResponse({ access_token: 'kc-access', refresh_token: 'rotated' }),
      )
      .mockResolvedValueOnce(okTextResponse('provider-access-token'));

    const svc = makeService();
    const user = makeUser();
    await expect(svc.getProviderAccessToken(user, 'google')).resolves.toBe('provider-access-token');

    expect(authService.storeKcRefreshToken).toHaveBeenCalledWith(user, 'rotated');
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://auth.example.test/realms/uchub/protocol/openid-connect/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://auth.example.test/realms/uchub/broker/google/token',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer kc-access',
        }),
      }),
    );
  });

  it('parses broker JSON payloads with access_token', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(refreshResponse({ access_token: 'kc-access' }))
      .mockResolvedValueOnce(okTextResponse(JSON.stringify({ access_token: 'provider-json' })));

    const svc = makeService();
    await expect(svc.getProviderAccessToken(makeUser(), 'microsoft')).resolves.toBe(
      'provider-json',
    );
  });

  it('parses broker JSON payloads with token', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(refreshResponse({ access_token: 'kc-access' }))
      .mockResolvedValueOnce(okTextResponse(JSON.stringify({ token: 'provider-token' })));

    const svc = makeService();
    await expect(svc.getProviderAccessToken(makeUser(), 'google')).resolves.toBe('provider-token');
  });

  it('accepts a raw broker body token', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(refreshResponse({ access_token: 'kc-access' }))
      .mockResolvedValueOnce(okTextResponse('raw-provider-token'));

    const svc = makeService();
    await expect(svc.getProviderAccessToken(makeUser(), 'google')).resolves.toBe(
      'raw-provider-token',
    );
  });

  it('returns null on broker HTTP failures', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(refreshResponse({ access_token: 'kc-access' }))
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'forbidden',
      });

    const svc = makeService();
    await expect(svc.getProviderAccessToken(makeUser(), 'google')).resolves.toBeNull();
  });

  function statusResponse(status: number, body?: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    };
  }

  function collectLogs() {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    return {
      text: () => JSON.stringify([...warn.mock.calls, ...log.mock.calls]),
      restore: () => {
        warn.mockRestore();
        log.mockRestore();
      },
    };
  }

  it('unlinks only the requested provider for the user whose token was refreshed', async () => {
    const logs = collectLogs();
    const userA = makeUser();
    const userB = {
      id: 'u2',
      kcRefreshTokenEnc: encrypt({ refresh_token: 'other-user-refresh' }),
    } as User;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        refreshResponse({ access_token: 'access-a', refresh_token: 'rotated-a' }),
      )
      .mockResolvedValueOnce(statusResponse(204))
      .mockResolvedValueOnce(statusResponse(200, [{ providerAlias: 'microsoft', connected: true }]))
      .mockResolvedValueOnce(
        refreshResponse({ access_token: 'access-b', refresh_token: 'rotated-b' }),
      )
      .mockResolvedValueOnce(statusResponse(204))
      .mockResolvedValueOnce(statusResponse(200, []));

    const svc = makeService();
    const first = await svc.unlinkBrokerIdentity(userA, 'google');
    const second = await svc.unlinkBrokerIdentity(userB, 'microsoft');

    expect(first).toEqual({
      ok: true,
      alreadyAbsent: false,
      remainingAliases: ['microsoft'],
    });
    expect(second).toEqual({ ok: true, alreadyAbsent: false, remainingAliases: [] });
    expect(JSON.stringify(first)).not.toMatch(/access-a|rotated-a|kc-refresh-token/);
    expect(JSON.stringify(second)).not.toMatch(/access-b|rotated-b|other-user-refresh/);

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(String(calls[0][1].body)).toContain('refresh_token=kc-refresh-token');
    expect(String(calls[0][1].body)).not.toContain('other-user-refresh');
    expect(calls[1][0]).toBe(
      'https://auth.example.test/realms/uchub/account/linked-accounts/google',
    );
    expect(calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ Authorization: 'Bearer access-a' }),
      }),
    );
    expect(String(calls[3][1].body)).toContain('refresh_token=other-user-refresh');
    expect(String(calls[3][1].body)).not.toContain('kc-refresh-token');
    expect(calls[4][0]).toBe(
      'https://auth.example.test/realms/uchub/account/linked-accounts/microsoft',
    );
    expect(calls[4][1].headers.Authorization).toBe('Bearer access-b');
    expect(
      calls
        .slice(3)
        .map((call) => String(call[0]))
        .join('\n'),
    ).not.toContain('google');
    expect(authService.storeKcRefreshToken).toHaveBeenNthCalledWith(1, userA, 'rotated-a');
    expect(authService.storeKcRefreshToken).toHaveBeenNthCalledWith(2, userB, 'rotated-b');
    expect(logs.text()).not.toMatch(
      /kc-refresh-token|other-user-refresh|access-a|access-b|rotated-a|rotated-b/,
    );
    logs.restore();
  });

  it('treats a broker outage as a typed failure and does not read another account', async () => {
    const logs = collectLogs();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(refreshResponse({ access_token: 'access-a' }))
      .mockResolvedValueOnce(statusResponse(503));

    const svc = makeService();
    await expect(svc.unlinkBrokerIdentity(makeUser(), 'google')).resolves.toEqual({
      ok: false,
      reason: 'broker_down',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(logs.text()).not.toMatch(/kc-refresh-token|access-a/);
    logs.restore();
  });

  it('reports the link already gone only after the list confirms it is absent', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(refreshResponse({ access_token: 'access-a' }))
      .mockResolvedValueOnce(statusResponse(400))
      .mockResolvedValueOnce(
        statusResponse(200, [{ providerAlias: 'microsoft', connected: true }]),
      );

    const svc = makeService();
    await expect(svc.unlinkBrokerIdentity(makeUser(), 'google')).resolves.toEqual({
      ok: true,
      alreadyAbsent: true,
      remainingAliases: ['microsoft'],
    });
  });

  it('keeps a refused unlink as rejected when the provider is still linked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(refreshResponse({ access_token: 'access-a' }))
      .mockResolvedValueOnce(statusResponse(400))
      .mockResolvedValueOnce(statusResponse(200, [{ providerAlias: 'google', connected: true }]));

    const svc = makeService();
    await expect(svc.unlinkBrokerIdentity(makeUser(), 'google')).resolves.toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('does not call Keycloak when this user has no stored refresh token', async () => {
    const svc = makeService();
    await expect(
      svc.unlinkBrokerIdentity({ id: 'u1', kcRefreshTokenEnc: null } as User, 'microsoft'),
    ).resolves.toEqual({ ok: false, reason: 'no_session' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
