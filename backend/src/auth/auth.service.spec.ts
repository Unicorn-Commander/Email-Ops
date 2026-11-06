import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from '../connected-accounts/crypto';

const KEY = Buffer.alloc(32, 19).toString('base64');

describe('AuthService.storeKcRefreshToken', () => {
  const prisma = {
    user: {
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;

  const jwt = {
    sign: jest.fn(),
  } as any;

  const prevKey = process.env.CONNECTED_ACCOUNT_ENC_KEY;

  beforeEach(() => {
    process.env.CONNECTED_ACCOUNT_ENC_KEY = KEY;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    else process.env.CONNECTED_ACCOUNT_ENC_KEY = prevKey;
  });

  function makeService() {
    return new AuthService(jwt, prisma);
  }

  it('encrypts and persists the Keycloak refresh token', async () => {
    const svc = makeService();
    await svc.storeKcRefreshToken({ id: 'u1' } as any, 'refresh-123');
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const arg = (prisma.user.update as jest.Mock).mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'u1' });
    expect(arg.data.kcRefreshUpdatedAt).toBeInstanceOf(Date);
    const decrypted = decrypt<{ refresh_token: string }>(arg.data.kcRefreshTokenEnc);
    expect(decrypted).toEqual({ refresh_token: 'refresh-123' });
  });

  it('no-ops when the refresh token is empty', async () => {
    const svc = makeService();
    await svc.storeKcRefreshToken({ id: 'u1' } as any, '');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('no-ops when the encryption key is missing', async () => {
    delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    const svc = makeService();
    await svc.storeKcRefreshToken({ id: 'u1' } as any, 'refresh-123');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('AuthService.generateTokenForUser', () => {
  const prisma = {} as PrismaService;
  const jwt = {
    sign: jest.fn().mockReturnValue('signed-session'),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes the stable Keycloak subject in local session tokens', async () => {
    const svc = new AuthService(jwt, prisma);
    const user = {
      id: 'local-user-id',
      keycloakId: 'keycloak-user-id',
      email: 'user@example.test',
      username: 'user',
      firstName: 'Test',
      lastName: 'User',
    } as any;

    const result = await svc.generateTokenForUser(user);

    expect(jwt.sign).toHaveBeenCalledWith({
      sub: 'local-user-id',
      uc_uid: 'keycloak-user-id',
      email: 'user@example.test',
      role: 'MEMBER',
      username: 'user',
    });
    expect(result.access_token).toBe('signed-session');
  });

  it('does not add an empty stable subject for an unlinked local user', async () => {
    const svc = new AuthService(jwt, prisma);
    const user = {
      id: 'local-user-id',
      keycloakId: null,
      email: 'user@example.test',
      username: 'user',
      firstName: 'Test',
      lastName: 'User',
    } as any;

    await svc.generateTokenForUser(user);

    expect(jwt.sign).toHaveBeenCalledWith({
      sub: 'local-user-id',
      email: 'user@example.test',
      role: 'MEMBER',
      username: 'user',
    });
  });
});

describe('AuthService.validateKeycloakUser avatar upsert', () => {
  function makeService(existing: any) {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...existing, ...data })),
      },
    } as unknown as PrismaService;
    return { service: new AuthService({} as any, prisma), prisma };
  }

  function existingUser(avatarUrl: string | null = null) {
    return {
      id: 'avatar-user-1',
      email: 'casey@example.test',
      username: 'casey',
      firstName: 'Casey',
      lastName: 'Example',
      keycloakId: 'kc-avatar-1',
      avatarUrl,
      isActive: true,
    };
  }

  it('stores the HTTPS picture claim on every SSO login', async () => {
    const { service, prisma } = makeService(existingUser());
    const avatarUrl = 'https://cdn.example.test/avatars/casey.png';

    const resolved = await service.validateKeycloakUser('kc-avatar-1', { picture: avatarUrl });

    expect(resolved.avatarUrl).toBe(avatarUrl);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'avatar-user-1' },
      data: expect.objectContaining({ avatarUrl }),
    });
  });

  it('clears the stored URL when the current token has no avatar claim', async () => {
    const { service, prisma } = makeService(
      existingUser('https://cdn.example.test/avatars/old-casey.png'),
    );

    const resolved = await service.validateKeycloakUser('kc-avatar-1', {});

    expect(resolved.avatarUrl).toBeNull();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'avatar-user-1' },
      data: expect.objectContaining({ avatarUrl: null }),
    });
  });

  it('rejects an oversized data URI instead of persisting it', async () => {
    const { service, prisma } = makeService(existingUser());
    const oversizedDataUri = `data:image/png;base64,${'A'.repeat(64 * 1024)}`;

    const resolved = await service.validateKeycloakUser('kc-avatar-1', {
      picture: oversizedDataUri,
    });

    expect(resolved.avatarUrl).toBeNull();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'avatar-user-1' },
      data: expect.objectContaining({ avatarUrl: null }),
    });
  });

  it('accepts the flat Keycloak avatar_url attribute when picture is absent', async () => {
    const { service } = makeService(existingUser());
    const avatarUrl = 'https://cdn.example.test/avatars/casey-attribute.png';

    const resolved = await service.validateKeycloakUser('kc-avatar-1', {
      attributes: { avatar_url: [avatarUrl] },
    });

    expect(resolved.avatarUrl).toBe(avatarUrl);
  });
});

describe('AuthService.validateJwtPayload avatar claims', () => {
  it('forwards picture and Keycloak attributes through the bearer upsert path', async () => {
    const prisma = { user: {} } as unknown as PrismaService;
    const service = new AuthService({} as any, prisma);
    const validateKeycloakUser = jest
      .spyOn(service, 'validateKeycloakUser')
      .mockResolvedValue({} as any);
    const avatarUrl = 'https://cdn.example.test/avatars/bearer.png';

    await service.validateJwtPayload(
      {
        iss: 'https://auth.example.test/realms/uchub',
        sub: 'kc-avatar-bearer',
        email: 'riley@example.test',
        email_verified: true,
        picture: avatarUrl,
        attributes: { picture: [avatarUrl] },
      },
      'signed-bearer-token',
    );

    expect(validateKeycloakUser).toHaveBeenCalledWith(
      'kc-avatar-bearer',
      expect.objectContaining({
        picture: avatarUrl,
        attributes: { picture: [avatarUrl] },
      }),
      'signed-bearer-token',
      expect.objectContaining({ cacheEntitlement: true }),
    );
  });
});
