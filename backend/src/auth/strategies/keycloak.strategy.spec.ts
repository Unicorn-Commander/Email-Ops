import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { KeycloakStrategy } from './keycloak.strategy';

describe('KeycloakStrategy.validate', () => {
  const config = {
    get: (key: string, fallback?: string) => {
      const values: Record<string, string | undefined> = {
        KEYCLOAK_URL: 'https://auth.example.test',
        KEYCLOAK_REALM: 'uchub',
        KEYCLOAK_CALLBACK_URL: '/api/v1/auth/keycloak/callback',
        KEYCLOAK_CLIENT_ID: 'email-ops',
        KEYCLOAK_CLIENT_SECRET: 'client-secret',
      };
      return values[key] ?? fallback;
    },
  } as unknown as ConfigService;

  const authService = {
    validateKeycloakUser: jest.fn(),
    storeKcRefreshToken: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('stores the refresh token after the user is resolved', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ sub: 'kc-sub', email: 'user@example.test' }),
    });
    (authService.validateKeycloakUser as jest.Mock).mockResolvedValue({ id: 'u1' });

    const strategy = new KeycloakStrategy(config, authService);
    await expect(strategy.validate('access-token', 'refresh-token', { sub: 'ignored' })).resolves.toEqual(
      { id: 'u1' },
    );

    expect(authService.validateKeycloakUser).toHaveBeenCalledWith('kc-sub', {
      sub: 'kc-sub',
      email: 'user@example.test',
    });
    expect(authService.storeKcRefreshToken).toHaveBeenCalledWith({ id: 'u1' }, 'refresh-token');
  });
});
