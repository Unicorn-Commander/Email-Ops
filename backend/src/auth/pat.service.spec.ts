import { NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  PatService,
  PAT_DAY_MS,
  PAT_DEFAULT_EXPIRY_DAYS,
  PAT_MAX_EXPIRY_DAYS,
} from './pat.service';
import { PrismaService } from '../prisma/prisma.service';

/** A valid, in-range mint request — the shape every mint must now supply. */
const VALID_OPTS = () => ({
  scopes: ['mail:read'],
  expiresAt: new Date(Date.now() + 30 * PAT_DAY_MS),
});

/**
 * Minimal in-memory fake for prisma.personalAccessToken, keyed the same way
 * the real table is (tokenHash unique, userId indexed), so the round-trip
 * tests exercise the real create -> hash -> lookup path rather than
 * hand-wiring mock return values per assertion.
 */
function makePrisma(users: Record<string, { id: string; isActive: boolean }>) {
  const store = new Map<string, any>();
  let seq = 0;

  const prisma = {
    personalAccessToken: {
      create: jest.fn(async ({ data }: any) => {
        seq += 1;
        const row = {
          id: `pat-${seq}`,
          userId: data.userId,
          name: data.name,
          tokenHash: data.tokenHash,
          tokenPrefix: data.tokenPrefix,
          scopes: data.scopes,
          expiresAt: data.expiresAt,
          lastUsedAt: null as Date | null,
          createdAt: new Date(),
          revokedAt: null as Date | null,
        };
        store.set(row.id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = [...store.values()].find((r) => r.tokenHash === where.tokenHash);
        if (!row) return null;
        const user = users[row.userId];
        return { ...row, user };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.get(where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = [...store.values()].find((r) => r.id === where.id && r.userId === where.userId);
        return row ? { id: row.id } : null;
      }),
      findMany: jest.fn(async ({ where, select }: any) => {
        const rows = [...store.values()].filter((r) => r.userId === where.userId);
        if (!select) return rows;
        return rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            if (select[key]) out[key] = r[key];
          }
          return out;
        });
      }),
    },
  } as unknown as PrismaService;

  return { prisma, store };
}

/**
 * Insert a row DIRECTLY, bypassing PatService.createPat — the only way to
 * reproduce a credential minted under the old (pre-hardening) defaults, e.g.
 * the one live token in the dogfood database.
 */
async function seedRawToken(
  prisma: PrismaService,
  data: {
    userId: string;
    name: string;
    plaintext: string;
    scopes: string[];
    expiresAt: Date | null;
  },
) {
  const tokenHash = createHash('sha256').update(data.plaintext, 'utf8').digest('hex');
  return (prisma as any).personalAccessToken.create({
    data: {
      userId: data.userId,
      name: data.name,
      tokenHash,
      tokenPrefix: data.plaintext.slice(0, 12),
      scopes: data.scopes,
      expiresAt: data.expiresAt,
    },
  });
}

describe('PatService', () => {
  it('mints and resolves a token — full round-trip', async () => {
    const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);

    const opts = VALID_OPTS();
    const minted = await svc.createPat('u1', 'my-agent', opts);
    expect(minted.token.startsWith('eo_pat_')).toBe(true);
    expect(minted.token.length).toBe('eo_pat_'.length + 32);
    expect(minted.tokenPrefix).toBe(minted.token.slice(0, 12));
    expect([...store.values()][0]).toMatchObject({
      scopes: ['mail:read'],
      expiresAt: opts.expiresAt,
    });

    const record = await svc.resolvePatRecord(minted.token);
    expect(record).toMatchObject({
      user: { id: 'u1' },
      scopes: ['mail:read'],
      expiresAt: opts.expiresAt.toISOString(),
      revokedAt: null,
    });
    await expect(svc.resolvePat(minted.token)).resolves.toMatchObject({ id: 'u1' });

    // lastUsedAt stamp is fire-and-forget; let the microtask flush.
    await new Promise((r) => setImmediate(r));
    expect(prisma.personalAccessToken.update as jest.Mock).toHaveBeenCalled();
  });

  it('normalizes explicit scopes and persists an expiry', async () => {
    const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);
    const expiresAt = new Date('2027-01-02T03:04:05.000Z');

    const minted = await svc.createPat('u1', 'scoped-agent', {
      scopes: [' mail:read ', 'mail:read', 'mail:*', 'agent-inbox:approve'],
      expiresAt,
    });

    expect(store.get(minted.id)).toMatchObject({
      scopes: ['mail:read', 'mail:*', 'agent-inbox:approve'],
      expiresAt,
    });
    await expect(svc.resolvePatRecord(minted.token)).resolves.toMatchObject({
      scopes: ['mail:read', 'mail:*', 'agent-inbox:approve'],
      expiresAt: expiresAt.toISOString(),
    });
  });

  it('rejects unknown, malformed, and unknown-prefix wildcard scopes', async () => {
    const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);

    const at = VALID_OPTS().expiresAt;
    await expect(
      svc.createPat('u1', 'bad', { scopes: ['mailish:read'], expiresAt: at }),
    ).rejects.toThrow('Unknown PAT scope');
    await expect(
      svc.createPat('u1', 'bad', { scopes: ['other:*'], expiresAt: at }),
    ).rejects.toThrow('Unknown PAT scope');
    await expect(
      svc.createPat('u1', 'bad', { scopes: [42 as any], expiresAt: at }),
    ).rejects.toThrow('PAT scopes must be strings');
    expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
  });

  it('rejects a garbage / wrong-prefix token without a DB lookup', async () => {
    const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);

    await expect(svc.resolvePat('mops_pat_totallywrongprefix')).resolves.toBeNull();
    await expect(svc.resolvePat('')).resolves.toBeNull();
    expect(prisma.personalAccessToken.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a revoked token', async () => {
    const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);

    const minted = await svc.createPat('u1', 'my-agent', VALID_OPTS());
    await svc.revokePat('u1', minted.id);

    await expect(svc.resolvePatRecord(minted.token)).resolves.toMatchObject({
      user: { id: 'u1' },
      revokedAt: expect.any(String),
    });
    await expect(svc.resolvePat(minted.token)).resolves.toBeNull();
  });

  it('returns expiry metadata but the legacy resolver rejects an expired token', async () => {
    const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);
    const expiresAt = new Date('2020-01-01T00:00:00.000Z');
    // Seeded raw: mint would now refuse a past expiry, but an ALREADY-issued
    // token that has since lapsed must still resolve-with-metadata and be
    // rejected by the legacy resolver exactly as before.
    const plaintext = 'eo_pat_EXPIRED000000000000000000000000000';
    await seedRawToken(prisma, {
      userId: 'u1',
      name: 'expired',
      plaintext,
      scopes: ['mail:read'],
      expiresAt,
    });

    await expect(svc.resolvePatRecord(plaintext)).resolves.toMatchObject({
      scopes: ['mail:read'],
      expiresAt: expiresAt.toISOString(),
    });
    await expect(svc.resolvePat(plaintext)).resolves.toBeNull();
  });

  it('rejects a token whose user is inactive', async () => {
    const { prisma } = makePrisma({ u1: { id: 'u1', isActive: false } });
    const svc = new PatService(prisma);

    const minted = await svc.createPat('u1', 'my-agent', VALID_OPTS());
    await expect(svc.resolvePat(minted.token)).resolves.toBeNull();
  });

  it('revokePat only affects the owner’s own token', async () => {
    const { prisma, store } = makePrisma({
      u1: { id: 'u1', isActive: true },
      u2: { id: 'u2', isActive: true },
    });
    const svc = new PatService(prisma);

    const minted = await svc.createPat('u1', 'my-agent', VALID_OPTS());

    await expect(svc.revokePat('u2', minted.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(store.get(minted.id).revokedAt).toBeNull();

    await svc.revokePat('u1', minted.id);
    expect(store.get(minted.id).revokedAt).toBeInstanceOf(Date);
  });

  it('listPats never surfaces tokenHash', async () => {
    const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);

    await svc.createPat('u1', 'my-agent', VALID_OPTS());
    const items = await svc.listPats('u1');
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('tokenHash');
  });
});

/**
 * MINT-SIDE HARDENING (fix/pat-mint-hardening).
 *
 * Two defects in how tokens are MINTED:
 *   1. omitting `scopes` silently minted a WILDCARD token — a credential route
 *      must default to least privilege, never full reach.
 *   2. a null expiry minted a PERMANENT credential that reaches a live mailbox.
 *
 * Both are refused at mint. Verification of ALREADY-ISSUED tokens is
 * deliberately untouched (see the regression block at the bottom).
 */
describe('PatService — mint-side hardening', () => {
  const futureAt = () => new Date(Date.now() + 30 * PAT_DAY_MS);

  describe('scopes must be explicit (no implicit wildcard)', () => {
    it('refuses an OMITTED scope list instead of upgrading it to *', async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      await expect(
        svc.createPat('u1', 'x', { expiresAt: futureAt() } as any),
      ).rejects.toThrow('PAT scopes are required');
      expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
    });

    it('refuses a NULL scope list', async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      await expect(
        svc.createPat('u1', 'x', { scopes: null as any, expiresAt: futureAt() }),
      ).rejects.toThrow('PAT scopes are required');
      expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
    });

    it('refuses an EMPTY scope array', async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      await expect(
        svc.createPat('u1', 'x', { scopes: [], expiresAt: futureAt() }),
      ).rejects.toThrow('PAT scopes must not be empty');
      expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
    });

    it('refuses a scope array that trims away to nothing', async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      await expect(
        svc.createPat('u1', 'x', { scopes: ['   '], expiresAt: futureAt() }),
      ).rejects.toThrow(/Unknown PAT scope|must not be empty/);
      await expect(
        svc.createPat('u1', 'x', { scopes: ['', '\t'], expiresAt: futureAt() }),
      ).rejects.toThrow(/Unknown PAT scope|must not be empty/);
      // A blank entry MIXED with a real one is refused too — it is never
      // silently dropped, which would mint a token the caller did not describe.
      await expect(
        svc.createPat('u1', 'x', { scopes: ['mail:read', '   '], expiresAt: futureAt() }),
      ).rejects.toThrow('Unknown PAT scope');
      expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
    });

    it('STILL accepts * when the caller asks for it deliberately', async () => {
      const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      const minted = await svc.createPat('u1', 'power-user', {
        scopes: ['*'],
        expiresAt: futureAt(),
      });
      expect(store.get(minted.id).scopes).toEqual(['*']);
      expect(minted.scopes).toEqual(['*']);
    });

    it('STILL accepts a prefix:* wildcard when asked for deliberately', async () => {
      const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      const minted = await svc.createPat('u1', 'mail-agent', {
        scopes: ['mail:*'],
        expiresAt: futureAt(),
      });
      expect(store.get(minted.id).scopes).toEqual(['mail:*']);
    });
  });

  describe('expiry is mandatory and bounded', () => {
    it('refuses a NULL expiry — no never-expiring credential can be minted', async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      await expect(
        svc.createPat('u1', 'forever', { scopes: ['mail:read'], expiresAt: null as any }),
      ).rejects.toThrow('PAT expiry is required');
      expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
    });

    it('refuses an OMITTED expiry', async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      await expect(
        svc.createPat('u1', 'forever', { scopes: ['mail:read'] } as any),
      ).rejects.toThrow('PAT expiry is required');
      expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
    });

    it(`refuses an expiry beyond ${PAT_MAX_EXPIRY_DAYS} days`, async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      const tooFar = new Date(Date.now() + (PAT_MAX_EXPIRY_DAYS + 1) * PAT_DAY_MS);
      await expect(
        svc.createPat('u1', 'too-long', { scopes: ['mail:read'], expiresAt: tooFar }),
      ).rejects.toThrow(`at most ${PAT_MAX_EXPIRY_DAYS} days`);
      expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
    });

    it(`accepts an expiry exactly at the ${PAT_MAX_EXPIRY_DAYS}-day ceiling`, async () => {
      const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      const atCeiling = new Date(Date.now() + PAT_MAX_EXPIRY_DAYS * PAT_DAY_MS - 1000);
      const minted = await svc.createPat('u1', 'max', {
        scopes: ['mail:read'],
        expiresAt: atCeiling,
      });
      expect(store.get(minted.id).expiresAt).toEqual(atCeiling);
    });

    it('accepts a SHORTER expiry than the default', async () => {
      const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      const soon = new Date(Date.now() + 1 * PAT_DAY_MS);
      const minted = await svc.createPat('u1', 'short', {
        scopes: ['mail:read'],
        expiresAt: soon,
      });
      expect(store.get(minted.id).expiresAt).toEqual(soon);
      expect(minted.expiresAt).toEqual(soon);
    });

    it('refuses an expiry already in the past', async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);

      await expect(
        svc.createPat('u1', 'past', {
          scopes: ['mail:read'],
          expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
      ).rejects.toThrow('must be in the future');
      expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
    });

    it(`defaultExpiry() is ${PAT_DEFAULT_EXPIRY_DAYS} days out and is itself mintable`, async () => {
      const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);
      const now = new Date('2026-07-30T00:00:00.000Z');

      expect(PatService.defaultExpiry(now).toISOString()).toBe('2026-10-28T00:00:00.000Z');
      expect(PatService.defaultExpiry(now).getTime() - now.getTime()).toBe(
        PAT_DEFAULT_EXPIRY_DAYS * PAT_DAY_MS,
      );

      const minted = await svc.createPat('u1', 'default', {
        scopes: ['mail:read'],
        expiresAt: PatService.defaultExpiry(),
      });
      expect(store.get(minted.id).expiresAt).toBeInstanceOf(Date);
    });
  });

  /**
   * COMPATIBILITY FENCE. There is exactly one token in the live dogfood DB and
   * it is BOTH never-expiring AND wildcard-scoped and NOT revoked. The mint-side
   * fix must never reach back and invalidate it.
   */
  describe('REGRESSION — already-issued legacy tokens keep verifying', () => {
    const LEGACY = 'eo_pat_LEGACY000000000000000000000000000A';

    async function withLegacyToken() {
      const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);
      await seedRawToken(prisma, {
        userId: 'u1',
        name: 'dogfood-legacy',
        plaintext: LEGACY,
        scopes: ['*'],
        expiresAt: null,
      });
      return { prisma, store, svc };
    }

    it('a NULL-expiry, wildcard-scoped, unrevoked token still resolves and verifies', async () => {
      const { svc } = await withLegacyToken();

      await expect(svc.resolvePatRecord(LEGACY)).resolves.toMatchObject({
        user: { id: 'u1' },
        scopes: ['*'],
        expiresAt: null,
        revokedAt: null,
      });
      // The legacy resolver (and therefore the guard) must still ACCEPT it.
      await expect(svc.resolvePat(LEGACY)).resolves.toMatchObject({ id: 'u1' });
    });

    it('still stamps lastUsedAt for the legacy token (verification path unchanged)', async () => {
      const { prisma, svc } = await withLegacyToken();
      (prisma.personalAccessToken.update as jest.Mock).mockClear();

      await svc.resolvePatRecord(LEGACY);
      await new Promise((r) => setImmediate(r));
      expect(prisma.personalAccessToken.update as jest.Mock).toHaveBeenCalled();
    });

    it('WARNS (never denies) when a legacy credential is used, and leaks no secret', async () => {
      const { svc } = await withLegacyToken();
      const warn = jest
        .spyOn((svc as any).logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(svc.resolvePat(LEGACY)).resolves.toMatchObject({ id: 'u1' });

      expect(warn).toHaveBeenCalled();
      const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toContain('no expiry');
      expect(line).toContain('wildcard scope');
      // Display prefix only — never the plaintext, never the sha256 hash.
      expect(line).toContain(LEGACY.slice(0, 12));
      expect(line).not.toContain(LEGACY);
      expect(line).not.toContain(
        createHash('sha256').update(LEGACY, 'utf8').digest('hex'),
      );
      warn.mockRestore();
    });

    it('does NOT warn for a modern scoped, expiring token', async () => {
      const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
      const svc = new PatService(prisma);
      const warn = jest
        .spyOn((svc as any).logger, 'warn')
        .mockImplementation(() => undefined);

      const minted = await svc.createPat('u1', 'modern', {
        scopes: ['mail:read'],
        expiresAt: new Date(Date.now() + 30 * PAT_DAY_MS),
      });
      await svc.resolvePatRecord(minted.token);

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
