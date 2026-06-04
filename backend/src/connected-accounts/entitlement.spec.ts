import { checkCleanerEntitlement } from './entitlement';

describe('checkCleanerEntitlement', () => {
  const WS = 'ws-cleaner';
  const enforce = () => ({ UC_ENTITLEMENT_MODE: 'enforce' }) as Record<string, string>;
  const open = () => ({ UC_ENTITLEMENT_MODE: 'open' }) as Record<string, string>;
  const get = (env: Record<string, string>) => (k: string) => env[k];

  it('allows when the caller has email-ops', () => {
    expect(checkCleanerEntitlement(['email-ops'], WS, get(enforce()))).toMatchObject({
      allowed: true,
      mode: 'enforce',
    });
  });

  it('denies when email-ops is missing in enforce mode', () => {
    const decision = checkCleanerEntitlement([], WS, get(enforce()));
    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe('enforce');
  });

  it('open bootstrap bypasses the sku gate', () => {
    expect(checkCleanerEntitlement([], WS, get(open()))).toMatchObject({
      allowed: true,
      mode: 'open',
    });
  });

  it('accepts SKU aliases via normalizeSku', () => {
    expect(checkCleanerEntitlement(['mail'], WS, get(enforce())).allowed).toBe(true);
    expect(checkCleanerEntitlement(['email_ops'], WS, get(enforce())).allowed).toBe(true);
  });
});
