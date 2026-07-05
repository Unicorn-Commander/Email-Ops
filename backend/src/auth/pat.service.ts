import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PersonalAccessToken, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Reserved prefix for Email-Ops PATs (SUITE-IDENTITY §D9). */
export const PAT_PREFIX = 'eo_pat_';

/** How many random chars follow the prefix in a minted token. */
const PAT_BODY_LENGTH = 32;

/** How many leading chars of the plaintext are kept as the display prefix. */
const PAT_DISPLAY_PREFIX_LENGTH = 12;

// Crockford-ish base32: no I, L, O, U (visually ambiguous with 1/1/0/V).
const PAT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface MintedPat {
  id: string;
  name: string;
  /** Plaintext token — returned ONCE, at mint time. Never retrievable again. */
  token: string;
  tokenPrefix: string;
  createdAt: Date;
}

export type PatSummary = Pick<
  PersonalAccessToken,
  'id' | 'name' | 'tokenPrefix' | 'lastUsedAt' | 'createdAt' | 'revokedAt'
>;

/**
 * Personal Access Tokens — a durable, user-mintable alternative to a
 * short-lived uchub JWT for the MCP surface (SUITE-IDENTITY §D9). Mirrors the
 * suite-wide PAT pattern (Meeting-Ops `mops_pat_` / Accounting-Ops
 * `aops_pat_`); Email-Ops' reserved prefix is `eo_pat_`.
 *
 * Only a token's sha256 hash is ever persisted — the plaintext is generated
 * here, returned once at mint time, and never stored or recoverable. Revoking
 * a token is a soft `revokedAt` stamp (never a delete), so audit history
 * survives.
 */
@Injectable()
export class PatService {
  private readonly logger = new Logger(PatService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** sha256 hex digest of the full plaintext token. */
  private static hash(plaintext: string): string {
    return createHash('sha256').update(plaintext, 'utf8').digest('hex');
  }

  /** Cryptographically random Crockford-ish base32 body (unbiased: 256 % 32 === 0). */
  private static randomBody(length: number): string {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += PAT_ALPHABET[bytes[i] % PAT_ALPHABET.length];
    }
    return out;
  }

  /**
   * Mint a new PAT for `userId`. Returns the plaintext token ONCE — the
   * caller (the /auth/pats controller) must surface it to the user
   * immediately; it cannot be recovered afterward.
   */
  async createPat(userId: string, name: string): Promise<MintedPat> {
    const plaintext = `${PAT_PREFIX}${PatService.randomBody(PAT_BODY_LENGTH)}`;
    const tokenHash = PatService.hash(plaintext);
    const tokenPrefix = plaintext.slice(0, PAT_DISPLAY_PREFIX_LENGTH);

    const row = await this.prisma.personalAccessToken.create({
      data: { userId, name, tokenHash, tokenPrefix },
    });

    return {
      id: row.id,
      name: row.name,
      token: plaintext,
      tokenPrefix: row.tokenPrefix,
      createdAt: row.createdAt,
    };
  }

  /**
   * Resolve a bearer credential to its owning User, mirroring the shape the
   * JWT path yields so `createServerForUser` and any downstream
   * workspace-scoping keep working unchanged. Returns null (never throws) on
   * any failure — wrong prefix, unknown/garbage token, revoked token, or an
   * inactive user — so the guard can uniformly answer 401.
   */
  async resolvePat(plaintext: string): Promise<User | null> {
    if (!plaintext || !plaintext.startsWith(PAT_PREFIX)) {
      return null;
    }

    const tokenHash = PatService.hash(plaintext);
    const record = await this.prisma.personalAccessToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record || record.revokedAt) {
      return null;
    }
    if (!record.user.isActive) {
      return null;
    }

    // Fire-and-forget last-used stamp: never let a metadata write block or
    // fail the authenticated request it is merely bookkeeping for.
    this.prisma.personalAccessToken
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch((err) => {
        this.logger.warn(`Failed to stamp lastUsedAt for PAT ${record.id}: ${(err as Error).message}`);
      });

    return record.user;
  }

  /** Non-secret fields only — NEVER returns tokenHash. */
  async listPats(userId: string): Promise<PatSummary[]> {
    return this.prisma.personalAccessToken.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Soft-revoke — only if `patId` belongs to `userId`; 404s otherwise. */
  async revokePat(userId: string, patId: string): Promise<void> {
    const row = await this.prisma.personalAccessToken.findFirst({
      where: { id: patId, userId },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException('Personal access token not found');
    }
    await this.prisma.personalAccessToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
  }
}
