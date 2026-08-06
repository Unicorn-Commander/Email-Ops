import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PersonalAccessToken, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { checkPat, KNOWN_SCOPES } from './pat-scope';

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

export interface CreatePatOptions {
  scopes?: string[];
  expiresAt?: Date | null;
}

export interface ResolvedPatRecord {
  user: User;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
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
  async createPat(userId: string, name: string, opts: CreatePatOptions = {}): Promise<MintedPat> {
    const scopes = PatService.normalizeScopes(opts.scopes ?? ['*']);
    const expiresAt = PatService.normalizeExpiry(opts.expiresAt);
    const plaintext = `${PAT_PREFIX}${PatService.randomBody(PAT_BODY_LENGTH)}`;
    const tokenHash = PatService.hash(plaintext);
    const tokenPrefix = plaintext.slice(0, PAT_DISPLAY_PREFIX_LENGTH);

    const row = await this.prisma.personalAccessToken.create({
      data: { userId, name, tokenHash, tokenPrefix, scopes, expiresAt },
    });

    return {
      id: row.id,
      name: row.name,
      token: plaintext,
      tokenPrefix: row.tokenPrefix,
      createdAt: row.createdAt,
    };
  }

  private static normalizeScopes(scopes: string[]): string[] {
    if (!Array.isArray(scopes)) {
      throw new BadRequestException('PAT scopes must be an array');
    }

    const known = new Set<string>(KNOWN_SCOPES);
    const wildcardPrefixes = new Set(KNOWN_SCOPES.map((scope) => scope.split(':', 1)[0]));
    const normalized: string[] = [];

    for (const raw of scopes) {
      if (typeof raw !== 'string') {
        throw new BadRequestException('PAT scopes must be strings');
      }
      const scope = raw.trim();
      const prefix = scope.endsWith(':*') ? scope.slice(0, -2) : null;
      if (scope !== '*' && !known.has(scope) && (!prefix || !wildcardPrefixes.has(prefix))) {
        throw new BadRequestException(`Unknown PAT scope: ${scope || '(empty)'}`);
      }
      if (!normalized.includes(scope)) {
        normalized.push(scope);
      }
    }

    return normalized;
  }

  private static normalizeExpiry(expiresAt: Date | null | undefined): Date | null {
    if (expiresAt == null) {
      return null;
    }
    if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) {
      throw new BadRequestException('PAT expiry must be a valid Date or null');
    }
    return expiresAt;
  }

  /**
   * Resolve a bearer credential to its owning User, mirroring the shape the
   * JWT path yields so `createServerForUser` and any downstream
   * workspace-scoping keep working unchanged. Returns null (never throws) for
   * a wrong prefix, unknown token, or inactive user. Revoked/expired records
   * are returned with their lifecycle stamps so the guard can explain its 401.
   */
  async resolvePatRecord(plaintext: string): Promise<ResolvedPatRecord | null> {
    if (!plaintext || !plaintext.startsWith(PAT_PREFIX)) {
      return null;
    }

    const tokenHash = PatService.hash(plaintext);
    const record = await this.prisma.personalAccessToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record) {
      return null;
    }
    if (!record.user.isActive) {
      return null;
    }

    const resolved: ResolvedPatRecord = {
      user: record.user,
      scopes: record.scopes,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      revokedAt: record.revokedAt?.toISOString() ?? null,
    };

    // Stamp only credentials that are current. Revoked/expired records still
    // resolve so the guard can return a precise authentication failure.
    const validity = checkPat(resolved, '*', new Date().toISOString());
    if (validity.ok || validity.reason === 'missing-scope') {
      this.prisma.personalAccessToken
        .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
        .catch((err) => {
          this.logger.warn(
            `Failed to stamp lastUsedAt for PAT ${record.id}: ${(err as Error).message}`,
          );
        });
    }

    return resolved;
  }

  /** Legacy user-only resolver retained for existing callers. */
  async resolvePat(plaintext: string): Promise<User | null> {
    const record = await this.resolvePatRecord(plaintext);
    if (!record) {
      return null;
    }
    const validity = checkPat(record, '*', new Date().toISOString());
    if (!validity.ok && validity.reason !== 'missing-scope') {
      return null;
    }
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
