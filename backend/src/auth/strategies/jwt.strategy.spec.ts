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
