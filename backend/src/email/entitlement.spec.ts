import { checkComposeEntitlement, normalizeSku } from './entitlement';

/**
 * The compose entitlement gate is the server-side dual-SKU check (mirrors the
 * cockpit's EmailOpsPort gate): SEND/DRAFT requires BOTH customer-ops AND
 * email-ops; the open bootstrap bypasses with a WARN; reads don't use this gate.
 */
describe('checkComposeEntitlement (dual-SKU)', () => {
  const WS = 'ws-aaaa';
  const enforce = () => ({ UC_ENTITLEMENT_MODE: 'enforce' }) as Record<string, string>;
  const open = () => ({ UC_ENTITLEMENT_MODE: 'open' }) as Record<string, string>;
  const get = (env: Record<string, string>) => (k: string) => env[k];

  it('PASS only when BOTH customer-ops AND email-ops are present (enforce)', () => {
    const d = checkComposeEntitlement(['customer-ops', 'email-ops'], WS, get(enforce()));
    expect(d).toMatchObject({ allowed: true, mode: 'enforce' });
  });

  it('DENY when email-ops is missing (enforce)', () => {
    const d = checkComposeEntitlement(['customer-ops'], WS, get(enforce()));
    expect(d.allowed).toBe(false);
    expect(d.mode).toBe('enforce');
  });

  it('DENY when no entitlements at all (enforce)', () => {
    expect(checkComposeEntitlement([], WS, get(enforce())).allowed).toBe(false);
  });

  it('OPEN bootstrap bypasses the dual-SKU check (allow + mode=open)', () => {
    expect(checkComposeEntitlement([], WS, get(open()))).toMatchObject({
      allowed: true,
      mode: 'open',
    });
  });

  it('falls back to EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE when UC_ENTITLEMENT_MODE is unset', () => {
    const d = checkComposeEntitlement([], WS, get({ EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE: 'open' }));
    expect(d).toMatchObject({ allowed: true, mode: 'open' });
  });

  it('accepts SKU aliases (email_ops / mail / customerops)', () => {
    expect(checkComposeEntitlement(['customerops', 'mail'], WS, get(enforce())).allowed).toBe(true);
    expect(checkComposeEntitlement(['customer_ops', 'email_ops'], WS, get(enforce())).allowed).toBe(
      true,
    );
  });

  it('normalizeSku maps known aliases to canonical SKUs', () => {
    expect(normalizeSku('mail')).toBe('email-ops');
    expect(normalizeSku('customerops')).toBe('customer-ops');
    expect(normalizeSku('unknown-sku')).toBe('unknown-sku');
  });

  it('defaults to enforce when no mode env is set', () => {
    expect(checkComposeEntitlement([], WS, () => undefined).mode).toBe('enforce');
  });
});
