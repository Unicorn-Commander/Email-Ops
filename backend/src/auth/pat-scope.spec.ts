import { checkPat, PatRecord, scopeSatisfies } from './pat-scope';

/**
 * Pure PAT scope + expiry gate. No DB, no clock — `nowIso` is injected. Covers
 * wildcard semantics, the segment-boundary rule, and the revoked > expired >
 * missing-scope precedence.
 */
describe('scopeSatisfies', () => {
  it('matches an exact scope', () => {
    expect(scopeSatisfies(['mail:read'], 'mail:read')).toBe(true);
    expect(scopeSatisfies(['mail:read'], 'mail:write')).toBe(false);
  });

  it('grants everything for the full wildcard *', () => {
    expect(scopeSatisfies(['*'], 'mail:read')).toBe(true);
    expect(scopeSatisfies(['*'], 'admin:provision')).toBe(true);
  });

  it('honors a prefix wildcard on the segment boundary', () => {
    expect(scopeSatisfies(['mail:*'], 'mail:read')).toBe(true);
    expect(scopeSatisfies(['mail:*'], 'mail:write')).toBe(true);
    // Different top-level segment is NOT granted.
    expect(scopeSatisfies(['mail:*'], 'admin:provision')).toBe(false);
    // Boundary rule: mail:* must not leak to a same-prefix-but-different word.
    expect(scopeSatisfies(['mail:*'], 'mailish:read')).toBe(false);
    // The bare prefix without a suffix is not itself granted.
    expect(scopeSatisfies(['mail:*'], 'mail:')).toBe(false);
  });

  it('returns false for empty held scopes', () => {
    expect(scopeSatisfies([], 'mail:read')).toBe(false);
  });

  it('is satisfied when ANY of multiple held scopes matches', () => {
    expect(scopeSatisfies(['ui:control', 'mail:read', 'cleaner:run'], 'mail:read')).toBe(true);
    expect(scopeSatisfies(['ui:control', 'cleaner:run'], 'mail:read')).toBe(false);
  });

  it('ignores malformed held entries (never grants, never throws)', () => {
    expect(scopeSatisfies(['', ' ', 'mail:read'], 'mail:read')).toBe(true);
    expect(scopeSatisfies([undefined as any, null as any, 42 as any], 'mail:read')).toBe(false);
    expect(scopeSatisfies(['*extra'], 'mail:read')).toBe(false);
  });

  it('rejects an empty required scope', () => {
    expect(scopeSatisfies(['*'], '')).toBe(false);
  });
});

describe('checkPat', () => {
  const NOW = '2026-07-17T12:00:00.000Z';
  const active = (over: Partial<PatRecord> = {}): PatRecord => ({
    scopes: ['mail:read'],
    expiresAt: null,
    revokedAt: null,
    ...over,
  });

  it('allows an active token that holds the required scope', () => {
    expect(checkPat(active(), 'mail:read', NOW)).toEqual({ ok: true });
  });

  it('denies with reason=missing-scope when the scope is absent', () => {
    expect(checkPat(active(), 'admin:provision', NOW)).toEqual({ ok: false, reason: 'missing-scope' });
  });

  it('never expires when expiresAt is null', () => {
    expect(checkPat(active({ expiresAt: null }), 'mail:read', NOW).ok).toBe(true);
  });

  it('denies with reason=expired when expiresAt is before nowIso', () => {
    const check = checkPat(active({ expiresAt: '2026-07-17T11:59:59.999Z' }), 'mail:read', NOW);
    expect(check).toEqual({ ok: false, reason: 'expired' });
  });

  it('is still valid at/after nowIso boundary (not-yet-expired)', () => {
    expect(checkPat(active({ expiresAt: NOW }), 'mail:read', NOW).ok).toBe(true);
    expect(checkPat(active({ expiresAt: '2026-07-17T12:00:00.001Z' }), 'mail:read', NOW).ok).toBe(true);
  });

  it('denies with reason=revoked even when the scope is valid', () => {
    const check = checkPat(active({ revokedAt: '2026-01-01T00:00:00.000Z' }), 'mail:read', NOW);
    expect(check).toEqual({ ok: false, reason: 'revoked' });
  });

  it('precedence: revoked > expired > missing-scope (all three failing → revoked)', () => {
    const check = checkPat(
      { scopes: [], expiresAt: '2020-01-01T00:00:00.000Z', revokedAt: '2020-01-01T00:00:00.000Z' },
      'admin:provision',
      NOW,
    );
    expect(check).toEqual({ ok: false, reason: 'revoked' });
  });

  it('precedence: expired beats missing-scope', () => {
    const check = checkPat({ scopes: [], expiresAt: '2020-01-01T00:00:00.000Z', revokedAt: null }, 'admin:provision', NOW);
    expect(check).toEqual({ ok: false, reason: 'expired' });
  });
});
