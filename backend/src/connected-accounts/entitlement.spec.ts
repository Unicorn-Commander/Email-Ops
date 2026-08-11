import { checkCleanerEntitlement, checkMailboxHostingEntitlement } from './entitlement';

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

describe('checkMailboxHostingEntitlement (the metered hosting add-on)', () => {
  const enforce = () => 'enforce';
  const open = () => 'open';

  it('allows a caller holding email-ops:mailbox', () => {
    const d = checkMailboxHostingEntitlement(['email-ops', 'email-ops:mailbox'], 'ws-1', enforce);
    expect(d.allowed).toBe(true);
  });

  it('DENIES the base email-ops SKU alone — hosting is a separate purchase', () => {
    // The whole point of the pricing split: a bundled suite seat entitles the
    // cleaner, not a mailbox we host and support.
    const d = checkMailboxHostingEntitlement(['email-ops', 'customer-ops'], 'ws-1', enforce);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/email-ops:mailbox/);
  });

  it('does not let a sub-SKU masquerade as the base SKU, or vice versa', () => {
    // normalizeSku does alias mapping, NOT prefix matching.
    expect(checkMailboxHostingEntitlement(['email-ops:vault'], 'ws-1', enforce).allowed).toBe(false);
    expect(checkCleanerEntitlement(['email-ops:mailbox'], 'ws-1', enforce).allowed).toBe(false);
  });

  it('open bootstrap mode bypasses it (dogfood parity)', () => {
    expect(checkMailboxHostingEntitlement([], 'ws-1', open).allowed).toBe(true);
  });
});
