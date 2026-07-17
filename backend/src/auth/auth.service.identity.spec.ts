import { randomUUID } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TEST_DATABASE_URL } from '../../test/test-db';

/**
 * Identity-resolution locks for the SSO/federation auth path (SUITE-IDENTITY §D1/§D6).
 *
 * Proves the hardened `validateKeycloakUser` resolution semantics:
 *   - an UNLINKED local row (keycloakId == null) links to its first verified sub;
 *   - re-login by keycloakId short-circuits (email is never re-read);
 *   - a verified token whose email matches a row that already carries a DIFFERENT
 *     sub is REFUSED by default (no silent account-takeover / keycloakId rebind);
 *   - the historical auto-rebind is available only behind
 *     EMAIL_OPS_ALLOW_KEYCLOAK_REBIND (the Keycloak-migration escape hatch);
 * plus the issuer-normalization + federation-actor routing in `validateJwtPayload`
 * (mocked prisma — no DB) and the pure `normalizeIssuer` canonicalizer.
 *
 * All DB rows use an `@itest.test` email + `kc-i-…` sub so cleanup is total.
 */
// Integration DB URL (verify Postgres). Overridable via TEST_DATABASE_URL (CI service container);
// defaults to the historical verify DB so local runs are unchanged.
const DB_URL = TEST_DATABASE_URL;

describe('AuthService.validateKeycloakUser — identity resolution (integration)', () => {
  let prisma: PrismaService;
  let service: AuthService;
  let seq = 0;
  const prevRebind = process.env.EMAIL_OPS_ALLOW_KEYCLOAK_REBIND;

  const email = (tag: string) => `${tag}-${(seq += 1)}@itest.test`;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    delete process.env.EMAIL_OPS_ALLOW_KEYCLOAK_REBIND; // default OFF (fail closed)
    prisma = new PrismaService();
    await prisma.$connect();
    service = new AuthService({} as any, prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { email: { endsWith: '@itest.test' } } });
    await prisma.$disconnect();
    if (prevRebind === undefined) delete process.env.EMAIL_OPS_ALLOW_KEYCLOAK_REBIND;
    else process.env.EMAIL_OPS_ALLOW_KEYCLOAK_REBIND = prevRebind;
  });

  it('links an UNLINKED local row (keycloakId == null) to its first verified sub', async () => {
    const e = email('link');
    const row = await prisma.user.create({
      data: { id: randomUUID(), email: e, username: e, keycloakId: null },
    });
    const sub = 'kc-i-link-' + seq;

    const resolved = await service.validateKeycloakUser(sub, { email: e });
    expect(resolved.id).toBe(row.id);
    expect(resolved.keycloakId).toBe(sub);

    const reread = await prisma.user.findUnique({ where: { id: row.id } });
    expect(reread?.keycloakId).toBe(sub); // persisted
  });

  it('re-login resolves by keycloakId FIRST and never re-reads/overwrites email', async () => {
    const e = email('relogin');
    const sub = 'kc-i-relogin-' + seq;
    await prisma.user.create({ data: { id: randomUUID(), email: e, username: e, keycloakId: sub } });

    // A second login with the SAME sub but a *different* email claim must return
    // the existing row unchanged (step 1 short-circuits; email is not a key here).
    const resolved = await service.validateKeycloakUser(sub, { email: 'spoofed@itest.test' });
    expect(resolved.email).toBe(e);
    expect(resolved.keycloakId).toBe(sub);
  });

  it('REFUSES to rebind a row that already carries a different sub (default — no takeover)', async () => {
    const e = email('victim');
    const originalSub = 'kc-i-original-' + seq;
    const row = await prisma.user.create({
      data: { id: randomUUID(), email: e, username: e, keycloakId: originalSub },
    });

    // An attacker token: new sub, same email → must be rejected, row untouched.
    await expect(
      service.validateKeycloakUser('kc-i-attacker-' + seq, { email: e }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const reread = await prisma.user.findUnique({ where: { id: row.id } });
    expect(reread?.keycloakId).toBe(originalSub); // unchanged — no silent rebind
  });

  it('allows the rebind ONLY when EMAIL_OPS_ALLOW_KEYCLOAK_REBIND is set (migration window)', async () => {
    const e = email('migrate');
    const oldSub = 'kc-i-old-' + seq;
    const newSub = 'kc-i-new-' + seq;
    const row = await prisma.user.create({
      data: { id: randomUUID(), email: e, username: e, keycloakId: oldSub },
    });

    process.env.EMAIL_OPS_ALLOW_KEYCLOAK_REBIND = 'true';
    try {
      const resolved = await service.validateKeycloakUser(newSub, { email: e });
      expect(resolved.id).toBe(row.id);
      expect(resolved.keycloakId).toBe(newSub);
    } finally {
      delete process.env.EMAIL_OPS_ALLOW_KEYCLOAK_REBIND;
    }

    const reread = await prisma.user.findUnique({ where: { id: row.id } });
    expect(reread?.keycloakId).toBe(newSub);
  });

  it('rejects an inactive user even on a valid keycloakId match', async () => {
    const e = email('inactive');
    const sub = 'kc-i-inactive-' + seq;
    await prisma.user.create({
      data: { id: randomUUID(), email: e, username: e, keycloakId: sub, isActive: false },
    });
    await expect(service.validateKeycloakUser(sub, { email: e })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AuthService.validateJwtPayload — issuer normalization + federation routing (mocked)', () => {
  const prevIssuers = process.env.BRIGADE_TRUSTED_ISSUERS;
  const prevActors = process.env.EMAIL_OPS_FEDERATION_ACTORS;

  const makeService = (user: User | null) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user),
      },
    } as unknown as PrismaService;
    return { service: new AuthService({} as any, prisma), prisma };
  };

  beforeEach(() => {
    process.env.BRIGADE_TRUSTED_ISSUERS = 'https://brigade.unicorncommander.ai';
    process.env.EMAIL_OPS_FEDERATION_ACTORS = 'customer-ops';
  });

  afterAll(() => {
    if (prevIssuers === undefined) delete process.env.BRIGADE_TRUSTED_ISSUERS;
    else process.env.BRIGADE_TRUSTED_ISSUERS = prevIssuers;
    if (prevActors === undefined) delete process.env.EMAIL_OPS_FEDERATION_ACTORS;
    else process.env.EMAIL_OPS_FEDERATION_ACTORS = prevActors;
  });

  it('recognizes a federation token whose issuer carries a TRAILING SLASH (normalization)', async () => {
    // Issuer config has no slash; the token does. Pre-normalization this fell
    // through to the local-session branch (and 401'd); now it routes to the
    // federation-actor branch and resolves the synthetic principal.
    const { service } = makeService(null);
    const principal = await service.validateJwtPayload({
      iss: 'https://brigade.unicorncommander.ai/',
      act: { client_id: 'customer-ops' },
      // no email / human identity → federation-actor branch
    });
    expect(principal.id).toBe('federation:customer-ops');
  });

  it('routes a trailing-slash Brigade *human* token into the access-list path, not local-session', async () => {
    const human = {
      id: 'u-human',
      email: 'h@itest.test',
      keycloakId: 'kc-h',
      isActive: true,
    } as User;
    const { service, prisma } = makeService(human);
    const resolved = await service.validateJwtPayload({
      iss: 'https://brigade.unicorncommander.ai/',
      sub: 'kc-h',
      email: 'h@itest.test',
    });
    expect(resolved.id).toBe('u-human');
    // Took the Keycloak/federation branch → looked the user up (by keycloakId),
    // rather than the local-session `findUnique({ id: sub })` path.
    expect((prisma.user.findUnique as jest.Mock)).toHaveBeenCalledWith({
      where: { keycloakId: 'kc-h' },
    });
  });

  it('rejects a federation actor that is NOT in EMAIL_OPS_FEDERATION_ACTORS', async () => {
    const { service } = makeService(null);
    await expect(
      service.validateJwtPayload({
        iss: 'https://brigade.unicorncommander.ai',
        act: { client_id: 'rogue-app' },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.normalizeIssuer', () => {
  it('strips a trailing slash', () => {
    expect(AuthService.normalizeIssuer('https://brigade.unicorncommander.ai/')).toBe(
      'https://brigade.unicorncommander.ai',
    );
  });
  it('strips multiple trailing slashes and trims', () => {
    expect(AuthService.normalizeIssuer('  https://x.test///  ')).toBe('https://x.test');
  });
  it('returns null for empty / non-string', () => {
    expect(AuthService.normalizeIssuer('')).toBeNull();
    expect(AuthService.normalizeIssuer('   ')).toBeNull();
    expect(AuthService.normalizeIssuer(undefined)).toBeNull();
    expect(AuthService.normalizeIssuer(123 as unknown)).toBeNull();
  });
  it('leaves an already-canonical issuer untouched', () => {
    expect(AuthService.normalizeIssuer('https://brigade.unicorncommander.ai')).toBe(
      'https://brigade.unicorncommander.ai',
    );
  });
});
