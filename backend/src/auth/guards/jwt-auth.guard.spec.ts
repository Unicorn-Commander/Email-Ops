import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatService } from '../pat.service';

function makeContext(opts: { authorization?: string; isPublic?: boolean }) {
  const req: any = { headers: { authorization: opts.authorization }, user: undefined };
  const setHeader = jest.fn();
  const res: any = { setHeader };
  const context: any = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  };
  return { context, req, res, setHeader };
}

describe('JwtAuthGuard', () => {
  function makeGuard(patService: Partial<PatService>) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as any;
    const guard = new JwtAuthGuard(reflector, patService as PatService);
    return { guard, reflector };
  }

  it('routes an eo_pat_ bearer through PatService and sets req.user + __patAuth on success', async () => {
    const resolvePatRecord = jest.fn().mockResolvedValue({
      user: { id: 'u1', email: 'a@b.com' },
      scopes: ['mail:read'],
      expiresAt: null,
      revokedAt: null,
    });
    const { guard } = makeGuard({ resolvePatRecord });
    const { context, req } = makeContext({ authorization: 'Bearer eo_pat_ABCDEFGHJKMN' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(resolvePatRecord).toHaveBeenCalledWith('eo_pat_ABCDEFGHJKMN');
    expect(req.user).toMatchObject({ id: 'u1' });
    expect(req.user.__patAuth).toEqual({
      scopes: ['mail:read'],
      expiresAt: null,
      revokedAt: null,
    });
  });

  it('rejects an eo_pat_ bearer that fails to resolve with 401 + WWW-Authenticate', async () => {
    const resolvePatRecord = jest.fn().mockResolvedValue(null);
    const { guard } = makeGuard({ resolvePatRecord });
    const { context, setHeader } = makeContext({ authorization: 'Bearer eo_pat_revokedtoken' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="email-ops-mcp"');
  });

  it('rejects an expired PAT before it can reach any protected route', async () => {
    const resolvePatRecord = jest.fn().mockResolvedValue({
      user: { id: 'u1', email: 'a@b.com' },
      scopes: ['mail:read'],
      expiresAt: '2020-01-01T00:00:00.000Z',
      revokedAt: null,
    });
    const { guard } = makeGuard({ resolvePatRecord });
    const { context, setHeader } = makeContext({ authorization: 'Bearer eo_pat_expiredtoken' });

    await expect(guard.canActivate(context)).rejects.toThrow('Personal access token expired');
    expect(setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="email-ops-mcp"');
  });

  it('rejects a revoked PAT before it can reach any protected route', async () => {
    const resolvePatRecord = jest.fn().mockResolvedValue({
      user: { id: 'u1', email: 'a@b.com' },
      scopes: ['*'],
      expiresAt: null,
      revokedAt: '2026-07-17T11:00:00.000Z',
    });
    const { guard } = makeGuard({ resolvePatRecord });
    const { context, req, setHeader } = makeContext({
      authorization: 'Bearer eo_pat_revokedtoken',
    });

    await expect(guard.canActivate(context)).rejects.toThrow('Personal access token revoked');
    expect(req.user).toBeUndefined();
    expect(setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="email-ops-mcp"');
  });

  it('falls through to the existing passport JWT path for a non-eo_pat_ bearer', async () => {
    const resolvePatRecord = jest.fn();
    const { guard } = makeGuard({ resolvePatRecord });
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true as any);
    const { context } = makeContext({ authorization: 'Bearer some.real.jwt' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(superSpy).toHaveBeenCalledWith(context);
    expect(resolvePatRecord).not.toHaveBeenCalled();
    superSpy.mockRestore();
  });

  it('falls through to the existing passport JWT path when there is no Authorization header', async () => {
    const resolvePatRecord = jest.fn();
    const { guard } = makeGuard({ resolvePatRecord });
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(false as any);
    const { context } = makeContext({ authorization: undefined });

    const result = await guard.canActivate(context);

    expect(result).toBe(false);
    expect(superSpy).toHaveBeenCalledWith(context);
    expect(resolvePatRecord).not.toHaveBeenCalled();
    superSpy.mockRestore();
  });

  it('short-circuits to true for @Public() routes without touching PatService or passport', async () => {
    const resolvePatRecord = jest.fn();
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as any;
    const guard = new JwtAuthGuard(reflector, { resolvePatRecord } as unknown as PatService);
    const { context } = makeContext({ authorization: 'Bearer eo_pat_whatever', isPublic: true });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(resolvePatRecord).not.toHaveBeenCalled();
  });
});
