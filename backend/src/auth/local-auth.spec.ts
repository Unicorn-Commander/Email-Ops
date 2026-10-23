import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

const EMAIL = 'admin@selfhost.example.test';
const PASSWORD = 'correct horse battery staple';

function makePrisma() {
  let user: any = null;
  const prisma = {
    user: {
      findUnique: jest.fn(async () => user),
      create: jest.fn(async ({ data }: any) => {
        user = {
          id: 'local-admin-id',
          email: data.email,
          username: data.username,
          firstName: data.firstName,
          lastName: data.lastName,
          keycloakId: data.keycloakId,
          passwordHash: data.passwordHash,
          isActive: data.isActive,
        };
        return user;
      }),
      update: jest.fn(async ({ data }: any) => {
        user = { ...user, ...data };
        return user;
      }),
    },
    workspace: {
      upsert: jest.fn(async ({ create }: any) => create),
    },
    membership: {
      upsert: jest.fn(async ({ create }: any) => create),
    },
  } as unknown as PrismaService;
  return { prisma, user: () => user };
}

describe('AuthService local bootstrap admin', () => {
  const previous = {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    workspace: process.env.DEFAULT_WORKSPACE_ID,
  };

  beforeEach(() => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = EMAIL;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = PASSWORD;
    process.env.DEFAULT_WORKSPACE_ID = '0190a000-7e57-7000-8000-00000000e001';
  });

  afterEach(() => {
    if (previous.email === undefined) delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    else process.env.BOOTSTRAP_ADMIN_EMAIL = previous.email;
    if (previous.password === undefined) delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    else process.env.BOOTSTRAP_ADMIN_PASSWORD = previous.password;
    if (previous.workspace === undefined) delete process.env.DEFAULT_WORKSPACE_ID;
    else process.env.DEFAULT_WORKSPACE_ID = previous.workspace;
  });

  it('creates an OWNER membership and issues the existing local JWT shape', async () => {
    const { prisma } = makePrisma();
    const jwt = { sign: jest.fn().mockReturnValue('local-session') } as any;
    const service = new AuthService(jwt, prisma);

    const result = await service.localLogin(EMAIL, PASSWORD);

    expect(result.access_token).toBe('local-session');
    expect((prisma as any).workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: '0190a000-7e57-7000-8000-00000000e001' } }),
    );
    expect((prisma as any).membership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userKey: 'local-admin-id',
          role: 'OWNER',
          status: 'ACTIVE',
        }),
      }),
    );
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'local-admin-id', email: EMAIL, role: 'MEMBER' }),
    );
  });

  it('rejects a wrong password without issuing a token', async () => {
    const { prisma } = makePrisma();
    const jwt = { sign: jest.fn() } as any;
    const service = new AuthService(jwt, prisma);

    await expect(service.localLogin(EMAIL, 'wrong password')).rejects.toThrow(
      'Invalid local admin credentials',
    );
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('does not expose the stored password hash in the session projection', async () => {
    const { prisma } = makePrisma();
    const jwt = { sign: jest.fn().mockReturnValue('local-session') } as any;
    const service = new AuthService(jwt, prisma);

    const result = await service.localLogin(EMAIL, PASSWORD);

    expect(result.user).not.toHaveProperty('passwordHash');
  });
});
