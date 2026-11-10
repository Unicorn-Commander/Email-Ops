import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { OpsCenterServiceJwtGuard, ProvisioningEnabledGuard } from './workspace-provisioning.auth';

const SECRET = 'fixture-provisioning-secret';

function context(authorization?: string): ExecutionContext {
  const request: any = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function config(values: Record<string, string>) {
  return new ConfigService({
    PROVISIONING_ENABLED: 'true',
    PROVISIONING_SERVICE_JWT_SECRET: SECRET,
    PROVISIONING_SERVICE_JWT_AUDIENCE: 'email-ops-provisioning',
    ...values,
  });
}

describe('workspace provisioning auth', () => {
  it('keeps the route invisible by default', () => {
    expect(() => new ProvisioningEnabledGuard(new ConfigService()).canActivate()).toThrow(
      /Not found/,
    );
  });

  it('accepts a live service JWT with the expected audience', () => {
    const token = jwt.sign({ sub: 'ops-center', aud: 'email-ops-provisioning' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: 300,
    });
    const ctx = context(`Bearer ${token}`);
    expect(new OpsCenterServiceJwtGuard(config({})).canActivate(ctx)).toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).provisioningPrincipal.sub).toBe('ops-center');
  });

  it.each([
    ['wrong audience', { aud: 'accounting-ops' }],
    ['expired', { aud: 'email-ops-provisioning', exp: Math.floor(Date.now() / 1000) - 10 }],
  ])('rejects a %s token', (_label, claims) => {
    const token = jwt.sign(claims, SECRET, { algorithm: 'HS256' });
    expect(() =>
      new OpsCenterServiceJwtGuard(config({})).canActivate(context(`Bearer ${token}`)),
    ).toThrow(/Invalid or expired/);
  });
});
