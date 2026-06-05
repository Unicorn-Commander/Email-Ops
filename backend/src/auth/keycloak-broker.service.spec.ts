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
      .mockResolvedValueOnce(refreshResponse({ access_token: 'kc-access', refresh_token: 'rotated' }))
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
});
