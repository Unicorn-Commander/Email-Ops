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

/** Milliseconds in a day — the unit PAT lifetimes are expressed in. */
export const PAT_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lifetime applied when an HTTP caller does not pick one. This default lives at
 * the ROUTE layer (PatsController) — `PatService.createPat` itself demands an
 * explicit expiry so no internal caller can accidentally mint a forever token.
 */
export const PAT_DEFAULT_EXPIRY_DAYS = 90;

/** Hard ceiling on a newly minted PAT's lifetime. Not negotiable at mint time. */
export const PAT_MAX_EXPIRY_DAYS = 365;

// Crockford-ish base32: no I, L, O, U (visually ambiguous with 1/1/0/V).
const PAT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface MintedPat {
  id: string;
  name: string;
  /** Plaintext token — returned ONCE, at mint time. Never retrievable again. */
  token: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date;
  createdAt: Date;
}

export interface CreatePatOptions {
  /**
   * REQUIRED. There is no implicit scope set: omitting this is a 400, never a
   * silent upgrade to `*`. `*` and `prefix:*` remain values a caller may ask
   * for deliberately.
   */
  scopes: string[];
  /** REQUIRED. A never-expiring PAT cannot be minted (max PAT_MAX_EXPIRY_DAYS). */
  expiresAt: Date;
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

  /**
   * Display prefixes already warned about in this process. Bounded by the
   * number of distinct never-expiring tokens, which the hardened mint path can
   * only shrink — so this cannot grow without limit.
   */
  private readonly warnedLegacyPrefixes = new Set<string>();

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
   *
   * Least privilege is MANDATORY at mint: `opts.scopes` and `opts.expiresAt`
   * are both required. Omitting scopes used to mean `['*']` and omitting the
   * expiry used to mean "never" — both are now 400s. This is a MINT-side rule
   * only: tokens already issued under the old defaults keep verifying exactly
   * as before (see `resolvePatRecord`).
   */
  async createPat(userId: string, name: string, opts: CreatePatOptions): Promise<MintedPat> {
    const scopes = PatService.normalizeScopes(opts?.scopes);
    const expiresAt = PatService.normalizeExpiry(opts?.expiresAt);
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
      scopes,
      expiresAt,
      createdAt: row.createdAt,
    };
  }

  /** The lifetime the HTTP route applies when the caller does not pick one. */
  static defaultExpiry(now: Date = new Date()): Date {
    return new Date(now.getTime() + PAT_DEFAULT_EXPIRY_DAYS * PAT_DAY_MS);
  }

  private static normalizeScopes(scopes: string[] | null | undefined): string[] {
    // A credential-issuing route defaults to LEAST privilege, never full reach:
    // an omitted / null scope list is refused rather than upgraded to `*`.
    if (scopes == null) {
      throw new BadRequestException(
        'PAT scopes are required — pass an explicit scope list (use ["*"] only if you deliberately want full reach)',
      );
    }
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

    // An empty array (or one that trims away to nothing) is the same "I did not
    // choose" signal as omitting the field — refuse it rather than mint a token
    // whose reach is decided elsewhere.
    if (normalized.length === 0) {
      throw new BadRequestException(
        'PAT scopes must not be empty — pass at least one scope (use ["*"] only if you deliberately want full reach)',
      );
    }

    return normalized;
  }

  private static normalizeExpiry(
    expiresAt: Date | null | undefined,
    now: Date = new Date(),
  ): Date {
    // A live credential that reaches a real mailbox is never permanent.
    if (expiresAt == null) {
      throw new BadRequestException(
        `PAT expiry is required — a never-expiring token cannot be minted (default ${PAT_DEFAULT_EXPIRY_DAYS} days, maximum ${PAT_MAX_EXPIRY_DAYS})`,
      );
    }
    if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) {
      throw new BadRequestException('PAT expiry must be a valid Date');
    }
    if (expiresAt.getTime() <= now.getTime()) {
      throw new BadRequestException('PAT expiry must be in the future');
    }
    if (expiresAt.getTime() > now.getTime() + PAT_MAX_EXPIRY_DAYS * PAT_DAY_MS) {
      throw new BadRequestException(
        `PAT expiry must be at most ${PAT_MAX_EXPIRY_DAYS} days from now`,
      );
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
      this.warnLegacyCredential(record.tokenPrefix, resolved);
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

  /**
   * Observability only — NEVER a denial. Tokens minted before the mint-side
   * hardening can be never-expiring and/or fully wildcard-scoped; they keep
   * working byte-for-byte as before, but the operator gets a WARN each time one
   * is presented so the credential can be rotated deliberately.
   *
   * Logs the DISPLAY PREFIX only — never the plaintext token, its sha256 hash,
   * or the Authorization header.
   */
  private warnLegacyCredential(tokenPrefix: string, record: ResolvedPatRecord): void {
    // A NULL expiry is the ONLY genuinely legacy trait: the mint path can no
    // longer produce one, so any token holding it predates the hardening.
    //
    // A wildcard scope is deliberately NOT warned on. `*` remains a legal thing
    // to ask for at mint time, so flagging it would label a compliant token
    // minted today as "legacy" and tell its owner to rotate to something the
    // API would have refused to make any differently.
    if (record.expiresAt !== null) {
      return;
    }

    // This runs on the hot path — resolvePatRecord fires on EVERY PAT-authed
    // request, and an MCP client polls. One line per credential per process,
    // not one per request: the operator needs to know the token exists, and
    // repeating it every few seconds buries every other log line. The set is
    // bounded by the number of distinct never-expiring tokens, which the mint
    // path now guarantees can only shrink.
    if (this.warnedLegacyPrefixes.has(tokenPrefix)) {
      return;
    }
    this.warnedLegacyPrefixes.add(tokenPrefix);

    const scopeNote = record.scopes.includes('*') ? ' It also carries the wildcard scope (*).' : '';
    this.logger.warn(
      `Legacy PAT ${tokenPrefix}… in use — no expiry (never expires). Still honored.${scopeNote} ` +
        'It predates the mint hardening and can no longer be reissued in this shape; ' +
        'rotate it to an expiring token, then revoke this one. ' +
        '(Logged once per credential per process.)',
    );
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
