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
    const resolvedUser = { id: 'u1', email: 'a@b.com' };
    const resolvePat = jest.fn().mockResolvedValue(resolvedUser);
    const { guard } = makeGuard({ resolvePat });
    const { context, req } = makeContext({ authorization: 'Bearer eo_pat_ABCDEFGHJKMN' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(resolvePat).toHaveBeenCalledWith('eo_pat_ABCDEFGHJKMN');
    expect(req.user).toMatchObject({ id: 'u1' });
    expect(req.user.__patAuth).toBe(true);
  });

  it('rejects an eo_pat_ bearer that fails to resolve with 401 + WWW-Authenticate', async () => {
    const resolvePat = jest.fn().mockResolvedValue(null);
    const { guard } = makeGuard({ resolvePat });
    const { context, setHeader } = makeContext({ authorization: 'Bearer eo_pat_revokedtoken' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="email-ops-mcp"');
  });

  it('falls through to the existing passport JWT path for a non-eo_pat_ bearer', async () => {
    const resolvePat = jest.fn();
    const { guard } = makeGuard({ resolvePat });
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true as any);
    const { context } = makeContext({ authorization: 'Bearer some.real.jwt' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(superSpy).toHaveBeenCalledWith(context);
    expect(resolvePat).not.toHaveBeenCalled();
    superSpy.mockRestore();
  });

  it('falls through to the existing passport JWT path when there is no Authorization header', async () => {
    const resolvePat = jest.fn();
    const { guard } = makeGuard({ resolvePat });
    const superSpy = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(false as any);
    const { context } = makeContext({ authorization: undefined });

    const result = await guard.canActivate(context);

    expect(result).toBe(false);
    expect(superSpy).toHaveBeenCalledWith(context);
    expect(resolvePat).not.toHaveBeenCalled();
    superSpy.mockRestore();
  });

  it('short-circuits to true for @Public() routes without touching PatService or passport', async () => {
    const resolvePat = jest.fn();
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as any;
    const guard = new JwtAuthGuard(reflector, { resolvePat } as unknown as PatService);
    const { context } = makeContext({ authorization: 'Bearer eo_pat_whatever', isPublic: true });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(resolvePat).not.toHaveBeenCalled();
  });
});
