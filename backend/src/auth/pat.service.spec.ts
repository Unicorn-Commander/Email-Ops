import { NotFoundException } from '@nestjs/common';
import { PatService } from './pat.service';
import { PrismaService } from '../prisma/prisma.service';

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

describe('PatService', () => {
  it('mints and resolves a token — full round-trip', async () => {
    const { prisma, store } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);

    const minted = await svc.createPat('u1', 'my-agent');
    expect(minted.token.startsWith('eo_pat_')).toBe(true);
    expect(minted.token.length).toBe('eo_pat_'.length + 32);
    expect(minted.tokenPrefix).toBe(minted.token.slice(0, 12));
    expect([...store.values()][0]).toMatchObject({ scopes: ['*'], expiresAt: null });

    const record = await svc.resolvePatRecord(minted.token);
    expect(record).toMatchObject({
      user: { id: 'u1' },
      scopes: ['*'],
      expiresAt: null,
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

    await expect(svc.createPat('u1', 'bad', { scopes: ['mailish:read'] })).rejects.toThrow(
      'Unknown PAT scope',
    );
    await expect(svc.createPat('u1', 'bad', { scopes: ['other:*'] })).rejects.toThrow(
      'Unknown PAT scope',
    );
    await expect(svc.createPat('u1', 'bad', { scopes: [42 as any] })).rejects.toThrow(
      'PAT scopes must be strings',
    );
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

    const minted = await svc.createPat('u1', 'my-agent');
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
    const minted = await svc.createPat('u1', 'expired', { scopes: ['mail:read'], expiresAt });

    await expect(svc.resolvePatRecord(minted.token)).resolves.toMatchObject({
      scopes: ['mail:read'],
      expiresAt: expiresAt.toISOString(),
    });
    await expect(svc.resolvePat(minted.token)).resolves.toBeNull();
  });

  it('rejects a token whose user is inactive', async () => {
    const { prisma } = makePrisma({ u1: { id: 'u1', isActive: false } });
    const svc = new PatService(prisma);

    const minted = await svc.createPat('u1', 'my-agent');
    await expect(svc.resolvePat(minted.token)).resolves.toBeNull();
  });

  it('revokePat only affects the owner’s own token', async () => {
    const { prisma, store } = makePrisma({
      u1: { id: 'u1', isActive: true },
      u2: { id: 'u2', isActive: true },
    });
    const svc = new PatService(prisma);

    const minted = await svc.createPat('u1', 'my-agent');

    await expect(svc.revokePat('u2', minted.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(store.get(minted.id).revokedAt).toBeNull();

    await svc.revokePat('u1', minted.id);
    expect(store.get(minted.id).revokedAt).toBeInstanceOf(Date);
  });

  it('listPats never surfaces tokenHash', async () => {
    const { prisma } = makePrisma({ u1: { id: 'u1', isActive: true } });
    const svc = new PatService(prisma);

    await svc.createPat('u1', 'my-agent');
    const items = await svc.listPats('u1');
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('tokenHash');
  });
});
