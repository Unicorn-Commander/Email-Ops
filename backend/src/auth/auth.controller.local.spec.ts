import { AuthController, LocalLoginDto } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController local login', () => {
  it('sets a non-secure cookie for an HTTP self-host frontend', async () => {
    const authService = {
      localLogin: jest.fn().mockResolvedValue({
        access_token: 'local-session',
        user: { id: 'user-1', email: 'admin@example.test' },
      }),
      isLocalLoginEnabled: jest.fn().mockReturnValue(true),
    } as unknown as AuthService;
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        const values: Record<string, string> = {
          AUTH_COOKIE_SECURE: 'false',
          FRONTEND_URL: 'http://127.0.0.1:3000',
          JWT_EXPIRES_IN: '1d',
        };
        return values[key] ?? fallback;
      }),
    } as any;
    const response = {
      cookie: jest.fn(),
      json: jest.fn((body) => body),
    } as any;
    const controller = new AuthController(authService, config, {} as any, {} as any, {} as any);

    const result = await controller.localLogin(
      { email: 'admin@example.test', password: 'correct horse battery staple' } as LocalLoginDto,
      response,
    );

    expect(result.access_token).toBe('local-session');
    expect(response.cookie).toHaveBeenCalledWith(
      'access_token',
      'local-session',
      expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'lax' }),
    );
  });

  it('reports whether local login is enabled without exposing credentials', () => {
    const authService = {
      isLocalLoginEnabled: jest.fn().mockReturnValue(true),
    } as unknown as AuthService;
    const controller = new AuthController(authService, {} as any, {} as any, {} as any, {} as any);

    expect(controller.localLoginEnabled()).toEqual({ enabled: true });
    expect(authService.isLocalLoginEnabled).toHaveBeenCalledTimes(1);
  });

  it('reports disabled when the backend has no local bootstrap credentials', () => {
    const authService = {
      isLocalLoginEnabled: jest.fn().mockReturnValue(false),
    } as unknown as AuthService;
    const controller = new AuthController(authService, {} as any, {} as any, {} as any, {} as any);

    expect(controller.localLoginEnabled()).toEqual({ enabled: false });
  });
});
