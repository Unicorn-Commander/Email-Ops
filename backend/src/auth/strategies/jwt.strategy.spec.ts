import { JwtStrategy } from './jwt.strategy';

/**
 * The audience-binding fence (SUITE-IDENTITY §1/§9.4): Email-Ops only accepts a
 * Brigade federation token minted FOR email-ops. A token with aud for another
 * app is rejected even when its signature + issuer verify. Plus the tolerant
 * entitlement reader (the dual-SKU gate's input).
 */
describe('JwtStrategy.audienceMatches', () => {
  it('matches a string aud equal to expected', () => {
    expect(JwtStrategy.audienceMatches('email-ops', 'email-ops')).toBe(true);
  });
  it('matches when expected is in an aud array', () => {
    expect(JwtStrategy.audienceMatches(['x', 'email-ops'], 'email-ops')).toBe(true);
  });
  it('REJECTS a token minted for another app (aud=accounting-ops)', () => {
    expect(JwtStrategy.audienceMatches('accounting-ops', 'email-ops')).toBe(false);
    expect(JwtStrategy.audienceMatches('customer-ops', 'email-ops')).toBe(false);
  });
  it('rejects a missing/empty aud', () => {
    expect(JwtStrategy.audienceMatches(undefined, 'email-ops')).toBe(false);
    expect(JwtStrategy.audienceMatches([], 'email-ops')).toBe(false);
  });
});

describe('JwtStrategy.readEntitlements', () => {
  it('reads a flat entitlements array', () => {
    expect(JwtStrategy.readEntitlements({ entitlements: ['customer-ops', 'email-ops'] })).toEqual([
      'customer-ops',
      'email-ops',
    ]);
  });
  it('reads a space/comma-separated string', () => {
    expect(JwtStrategy.readEntitlements({ entitlements: 'customer-ops, email-ops' })).toEqual([
      'customer-ops',
      'email-ops',
    ]);
  });
  it('falls back to products, then subscription.products', () => {
    expect(JwtStrategy.readEntitlements({ products: ['email-ops'] })).toEqual(['email-ops']);
    expect(
      JwtStrategy.readEntitlements({ subscription: { products: ['customer-ops'] } }),
    ).toEqual(['customer-ops']);
  });
  it('reads {code, active} objects and drops inactive', () => {
    expect(
      JwtStrategy.readEntitlements({
        entitlements: [{ code: 'email-ops', active: true }, { code: 'x', active: false }],
      }),
    ).toEqual(['email-ops']);
  });
  it('returns [] for no claim', () => {
    expect(JwtStrategy.readEntitlements({})).toEqual([]);
  });
});

describe('JwtStrategy.validate ucUid resolution', () => {
  function makeStrategy(user: any) {
    const strategy = Object.create(JwtStrategy.prototype) as any;
    strategy.authService = {
      validateJwtPayload: jest.fn().mockResolvedValue(user),
    };
    strategy.brigadeTrustedIssuers = new Set<string>();
    strategy.brigadeExpectedAudience = 'email-ops';
    strategy.logger = { warn: jest.fn() };
    return strategy as JwtStrategy;
  }

  it('uses uc_uid from a new local session token', async () => {
    const user = { id: 'local-user-id', keycloakId: 'keycloak-user-id' };
    const strategy = makeStrategy(user);

    const validated = await strategy.validate({
      sub: user.id,
      uc_uid: user.keycloakId,
    });

    expect((validated as any).__ucUid).toBe(user.keycloakId);
  });

  it('resolves the stable subject for a pre-claim local session token', async () => {
    const user = { id: 'local-user-id', keycloakId: 'keycloak-user-id' };
    const strategy = makeStrategy(user);

    const validated = await strategy.validate({ sub: user.id });

    expect((validated as any).__ucUid).toBe(user.keycloakId);
  });

  it('falls back to the token subject when the user is not Keycloak-linked', async () => {
    const user = { id: 'local-user-id', keycloakId: null };
    const strategy = makeStrategy(user);

    const validated = await strategy.validate({ sub: user.id });

    expect((validated as any).__ucUid).toBe(user.id);
  });
});
