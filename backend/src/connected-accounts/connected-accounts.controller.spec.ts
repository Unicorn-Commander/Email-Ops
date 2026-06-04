import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ConnectedAccountsService } from './connected-accounts.service';
import { ConnectedAccountsController } from './connected-accounts.controller';
import { signOAuthState } from './oauth-state';

describe('ConnectedAccountsController', () => {
  const WS = '0190a000-7e57-7000-8000-00000000abcd';
  const prevPublicUrl = process.env.CONNECTED_ACCOUNT_PUBLIC_URL;
  const prevStateSecret = process.env.CONNECTED_ACCOUNT_STATE_SECRET;
  const prevJwt = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.CONNECTED_ACCOUNT_PUBLIC_URL = 'https://emailops.example.test';
    process.env.CONNECTED_ACCOUNT_STATE_SECRET = 'state-secret';
    process.env.JWT_SECRET = 'jwt-secret';
    process.env.UC_ENTITLEMENT_MODE = 'enforce';
  });

  afterEach(() => {
    if (prevPublicUrl === undefined) delete process.env.CONNECTED_ACCOUNT_PUBLIC_URL;
    else process.env.CONNECTED_ACCOUNT_PUBLIC_URL = prevPublicUrl;
    if (prevStateSecret === undefined) delete process.env.CONNECTED_ACCOUNT_STATE_SECRET;
    else process.env.CONNECTED_ACCOUNT_STATE_SECRET = prevStateSecret;
    if (prevJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwt;
    delete process.env.UC_ENTITLEMENT_MODE;
  });

  function userWith(entitlements: string[]): User {
    const u: WithWorkspaceClaim = {
      id: 'user-1',
      email: 'user@example.com',
      username: 'user',
      firstName: 'Test',
      lastName: 'User',
      keycloakId: 'uc-sub-1',
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __workspaceClaim: WS,
      __ucUid: 'uc-sub-1',
      __entitlements: entitlements,
    };
    return u as User;
  }

  function makeCtrl(overrides?: {
    membership?: Partial<MembershipService>;
    service?: Partial<ConnectedAccountsService>;
  }) {
    const membership = {
      resolveAndAuthorize: jest.fn().mockResolvedValue(WS),
      ...(overrides?.membership ?? {}),
    } as unknown as MembershipService;
    const service = {
      getConnectUrl: jest.fn().mockResolvedValue({ authorizeUrl: 'https://engine.example/auth' }),
      connectAccount: jest.fn().mockResolvedValue({ id: 'acct-1' }),
      ...(overrides?.service ?? {}),
    } as unknown as ConnectedAccountsService;
    return {
      ctrl: new ConnectedAccountsController(membership, service),
      membership,
      service,
    };
  }

  it('initiate returns an authorizeUrl and verifiable state', async () => {
    const { ctrl, service } = makeCtrl();
    const out = await ctrl.connect('google', WS, userWith(['email-ops']));
    expect(service.getConnectUrl).toHaveBeenCalledWith(
      WS,
      'uc-sub-1',
      'gmail',
      'https://emailops.example.test/api/v1/connected-accounts/callback/google',
    );
    expect(out.authorizeUrl).toContain('state=');
    expect(out.state).toBeDefined();
    expect(out.authorizeUrl).toContain(encodeURIComponent(out.state));
  });

  it('initiate is blocked without the cleaner SKU in enforce mode', async () => {
    const { ctrl, service } = makeCtrl();
    await expect(ctrl.connect('google', WS, userWith([]))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(service.getConnectUrl).not.toHaveBeenCalled();
  });

  it('initiate is allowed in open mode without the cleaner SKU', async () => {
    process.env.UC_ENTITLEMENT_MODE = 'open';
    const { ctrl } = makeCtrl();
    await expect(ctrl.connect('microsoft', WS, userWith([]))).resolves.toMatchObject({
      authorizeUrl: expect.stringContaining('state='),
    });
  });

  it('initiate returns 503 when the engine is not configured', async () => {
    const { ctrl } = makeCtrl({
      service: { getConnectUrl: jest.fn().mockResolvedValue({ authorizeUrl: null }) },
    });
    await expect(ctrl.connect('google', WS, userWith(['email-ops']))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('callback rejects a tampered state', async () => {
    const { ctrl, service } = makeCtrl();
    const state = signOAuthState({
      workspaceId: WS,
      provider: 'gmail',
      ucUid: 'uc-sub-1',
      nonce: 'nonce',
      iat: Date.now(),
    });
    const [payload, signature] = state.split('.');
    const tamperedSignature = `${signature.slice(0, 1) === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    await expect(
      ctrl.callback(
        'google',
        'code-123',
        `${payload}.${tamperedSignature}`,
        undefined,
        undefined,
        userWith(['email-ops']),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.connectAccount).not.toHaveBeenCalled();
  });

  it('callback rejects an expired state', async () => {
    const { ctrl, service } = makeCtrl();
    const state = signOAuthState({
      workspaceId: WS,
      provider: 'gmail',
      ucUid: 'uc-sub-1',
      nonce: 'nonce',
      iat: Date.now() - 11 * 60 * 1000,
    });
    await expect(
      ctrl.callback('google', 'code-123', state, undefined, undefined, userWith(['email-ops'])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.connectAccount).not.toHaveBeenCalled();
  });

  it('callback handles provider denial cleanly', async () => {
    const { ctrl, service } = makeCtrl();
    await expect(
      ctrl.callback(
        'google',
        undefined,
        undefined,
        'access_denied',
        'user cancelled',
        userWith(['email-ops']),
      ),
    ).rejects.toThrow('user cancelled');
    expect(service.connectAccount).not.toHaveBeenCalled();
  });

  it('callback calls connectAccount with the exact redirectUri used to mint the flow', async () => {
    const { ctrl, service } = makeCtrl({
      service: {
        connectAccount: jest.fn().mockResolvedValue({ id: 'acct-1', provider: 'gmail' }),
      },
    });
    const state = signOAuthState({
      workspaceId: WS,
      provider: 'gmail',
      ucUid: 'uc-sub-1',
      nonce: 'nonce',
      iat: Date.now(),
    });
    const out = await ctrl.callback('google', 'code-123', state, undefined, undefined, userWith(['email-ops']));
    expect(service.connectAccount).toHaveBeenCalledWith(WS, 'uc-sub-1', {
      provider: 'gmail',
      code: 'code-123',
      redirectUri:
        'https://emailops.example.test/api/v1/connected-accounts/callback/google',
    });
    expect(out).toEqual({ id: 'acct-1', provider: 'gmail' });
  });
});
