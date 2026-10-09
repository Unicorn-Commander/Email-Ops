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
