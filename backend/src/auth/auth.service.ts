import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { resolveUserAccess, describeAccessList } from './access-list';
import { encrypt, isEncryptionConfigured } from '../connected-accounts/crypto';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  username: string;
}

/**
 * Email-Ops authentication.
 *
 * Greenfield + SSO-only: there is no local password flow. Identity comes from
 * the uchub Keycloak realm (RS256), either via the OIDC browser callback or a
 * forwarded realm/Brigade token. Every entry point JIT-provisions the User row
 * through the SAME access-list gate (SUITE-IDENTITY §D5) so no path bypasses
 * policy, and resolves by `keycloakId`/`sub` FIRST (email is a linking fallback
 * only). A valid token still grants ZERO workspace access until a Membership
 * row exists — that gate lives in MembershipService.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {
    const meta = describeAccessList();
    this.logger.log(
      `SSO access list: ${meta.ruleCount} rule${meta.ruleCount === 1 ? '' : 's'} (source: ${meta.source})`,
    );
  }

  /**
   * Resolve (or JIT-provision) the Email-Ops User for a verified Keycloak
   * identity. Resolution order (SUITE-IDENTITY §D1):
   *   1. by keycloakId (== uchub sub) — the canonical key.
   *   2. by email — LINKS an existing *unlinked* local row to this sub. It does
   *      NOT silently rebind a row that already carries a different sub (that is
   *      an account-identity conflict, not a link — see below).
   *   3. neither — JIT-create, GATED by the access list.
   */
  async validateKeycloakUser(keycloakId: string, profile: any): Promise<User> {
    const email: string | undefined = profile?.email;
    // The Keycloak `picture` claim (suite avatar spine) — only trust an absolute
    // URL, and never null out a stored photo on a login whose userinfo omits it.
    const picture: string | null =
      typeof profile?.picture === 'string' && /^https?:\/\//.test(profile.picture)
        ? profile.picture
        : null;

    // 1. keycloakId / sub first (the canonical, unique key).
    let user = await this.prisma.user.findUnique({ where: { keycloakId } });

    // 2. email linking fallback — link an UNLINKED local row (keycloakId == null)
    //    to its first verified sub. We do NOT silently REBIND a row that already
    //    carries a DIFFERENT sub: an email resolving to a different Keycloak
    //    identity is a conflict (email reuse / offboarding / a forged email
    //    claim), and rebinding would hand the existing account — its id, stored
    //    Keycloak refresh token, and any id-keyed data — to the new sub. (Note it
    //    would NOT even transfer workspace access: memberships key off keycloakId,
    //    so a rebind orphans them — auto-rebind was never a complete migration
    //    path.) The historical auto-rebind is preserved behind
    //    EMAIL_OPS_ALLOW_KEYCLOAK_REBIND (default OFF = fail closed), for a
    //    Keycloak realm migration where users keep their email but get a new sub
    //    — and even then the operator must also re-key memberships.
    if (!user && email) {
      const byEmail = await this.prisma.user.findUnique({ where: { email } });
      if (byEmail) {
        if (!byEmail.keycloakId) {
          user = await this.prisma.user.update({
            where: { id: byEmail.id },
            data: { keycloakId },
          });
          this.logger.log(`Linked existing local user ${email} to Keycloak sub ${keycloakId}`);
        } else if (AuthService.allowKeycloakRebind()) {
          user = await this.prisma.user.update({
            where: { id: byEmail.id },
            data: { keycloakId },
          });
          this.logger.warn(
            `Rebound ${email} from Keycloak sub ${byEmail.keycloakId} to ${keycloakId} ` +
              `(EMAIL_OPS_ALLOW_KEYCLOAK_REBIND enabled — migration window; re-key memberships too)`,
          );
        } else {
          this.logger.warn(
            `Refusing to rebind ${email}: existing Keycloak sub ${byEmail.keycloakId} != token ` +
              `sub ${keycloakId}. Enable EMAIL_OPS_ALLOW_KEYCLOAK_REBIND only during a Keycloak migration.`,
          );
          throw new UnauthorizedException(
            'This email is already linked to a different identity. Contact your administrator.',
          );
        }
      }
    }

    // 3. JIT-provision, access-list gated.
    if (!user) {
      const access = resolveUserAccess(email);
      if (!access.allowed) {
        this.logger.warn(`Rejected SSO JIT for ${email || '(no email)'} — ${access.reason}`);
        throw new UnauthorizedException(
          'You are not authorized for Email-Ops. Contact your administrator.',
        );
      }
      // Username uniqueness: prefer preferred_username, else email; the unique
      // constraint guarantees we never silently collide.
      const username = profile?.preferred_username || profile?.username || email!;
      user = await this.prisma.user.create({
        data: {
          email: email!,
          username,
          firstName: profile?.given_name || profile?.firstName || '',
          lastName: profile?.family_name || profile?.lastName || '',
          picture,
          keycloakId,
        },
      });
      this.logger.log(
        `Created user from Keycloak SSO: ${email} (role-on-seed ${access.role}; ${access.reason})`,
      );
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    user = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), ...(picture ? { picture } : {}) },
    });
    return user;
  }

  /** Mint a local HS256 session token for a resolved user (post OIDC callback). */
  async generateTokenForUser(user: User) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: 'MEMBER',
      username: user.username,
    };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    };
  }

  /**
   * Store the user's Keycloak refresh token encrypted at rest. This is a
   * degrade-clean side-effect: if the token is empty or the encryption key is
   * unset, the call is a no-op.
   */
  async storeKcRefreshToken(user: User, refreshToken?: string | null): Promise<void> {
    const token = refreshToken?.trim();
    if (!token || !isEncryptionConfigured()) {
      return;
    }

    let encrypted: string;
    try {
      encrypted = encrypt({ refresh_token: token });
    } catch {
      return;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        kcRefreshTokenEnc: encrypted,
        kcRefreshUpdatedAt: new Date(),
      },
    });
  }

  /**
   * Disambiguate a verified JWT payload by its `iss` claim and resolve the
   * Email-Ops User (SUITE-IDENTITY §D6):
   *   - Keycloak realm token (`iss` has `/realms/`) OR Brigade federation token
   *     (`iss` in BRIGADE_TRUSTED_ISSUERS) → reuse the access-list-gated
   *     validateKeycloakUser path. No path auto-provisions outside the gate.
   *   - Locally-signed session token (no/foreign `iss`) → resolve by local id.
   */
  async validateJwtPayload(payload: any): Promise<User> {
    // Normalize the issuer (trim + strip trailing slash) BEFORE matching, using
    // the same helper the JWT strategy uses to build its JWKS/issuer sets — so a
    // trailing-slash config can't make a verified Brigade token fall through to
    // the local-session branch (issuer-normalization divergence, defense in depth).
    const issuer = AuthService.normalizeIssuer(payload?.iss);
    const isKeycloakRealmToken = !!issuer && issuer.includes('/realms/');
    const isBrigadeFederationToken =
      !!issuer && AuthService.brigadeTrustedIssuers().includes(issuer);

    if (isKeycloakRealmToken || isBrigadeFederationToken) {
      // Brigade's transitional sub may be an email; surface it as the profile
      // email so the access-list + email-link path still resolves. Harmless for
      // Keycloak realm tokens (which DO emit email) and for the long-term
      // opaque-sub Brigade model (Brigade emits email separately then).
      const subLooksLikeEmail = typeof payload.sub === 'string' && payload.sub.includes('@');

      // Federation-actor branch: a cross-app SERVICE caller carries an RFC-8693
      // `act.client_id` and no human identity → resolve to a synthetic, allow-listed
      // federation principal instead of running it through the human access-list gate
      // (which would reject it). Mirrors the Project-Ops federation pattern.
      const actorClientId =
        payload?.act && typeof payload.act.client_id === 'string'
          ? payload.act.client_id.trim()
          : null;
      const hasHumanIdentity = !!payload?.email || subLooksLikeEmail;
      if (actorClientId && !hasHumanIdentity) {
        if (AuthService.federationActors().includes(actorClientId)) {
          this.logger.log(`Federation actor authorized: ${actorClientId}`);
          return AuthService.buildFederationPrincipal(actorClientId);
        }
        this.logger.warn(
          `Rejected federation actor '${actorClientId}' — not in EMAIL_OPS_FEDERATION_ACTORS`,
        );
      }

      const profile = {
        email: payload.email ?? (subLooksLikeEmail ? payload.sub : undefined),
        preferred_username: payload.preferred_username,
        given_name: payload.given_name,
        family_name: payload.family_name,
      };
      return this.validateKeycloakUser(payload.sub, profile);
    }

    // Locally-signed session token.
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }
    return user;
  }

  /**
   * Parse BRIGADE_TRUSTED_ISSUERS (comma-separated). Defaults to the
   * customer-facing prod broker. Set to "" to disable the federation branch.
   * Read each call so test/runtime env changes take effect without a restart.
   */
  private static brigadeTrustedIssuers(): readonly string[] {
    const raw = process.env.BRIGADE_TRUSTED_ISSUERS;
    if (raw === undefined || raw === null) {
      return ['https://brigade.unicorncommander.ai'];
    }
    return raw
      .split(',')
      .map((s) => AuthService.normalizeIssuer(s))
      .filter((s): s is string => !!s);
  }

  /**
   * Canonicalize an issuer string: trim, strip trailing slash(es), return null
   * for a non-string/empty value. Shared by AuthService (the federation-token
   * branch) AND JwtStrategy (the JWKS-client map + the per-request audience
   * gate) so issuer matching is identical on the signature side and the
   * resolution side — a trailing slash on either the config or the token can't
   * route a verified federation token to the wrong branch.
   */
  static normalizeIssuer(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/\/+$/, '');
    return trimmed || null;
  }

  /**
   * Whether to REBIND an existing user row's keycloakId when a verified token
   * presents the same email but a different sub. Default OFF (secure: an
   * email→different-sub collision is an identity conflict, not a silent
   * takeover). Enable ONLY during a Keycloak realm migration where users keep
   * their email but receive a new sub — and re-key memberships in the same
   * migration, since they bind to keycloakId. Read per-call so an operator can
   * flip it without a code change.
   */
  private static allowKeycloakRebind(): boolean {
    const raw = process.env.EMAIL_OPS_ALLOW_KEYCLOAK_REBIND;
    return raw === 'true' || raw === '1';
  }

  /**
   * A synthetic, non-DB principal for a cross-app federation actor. Mirrors the
   * suite pattern (Project-Ops): a service caller authenticates as
   * `federation:<actor>` and is authorized downstream by the Brigade-vouched
   * workspace claim, never the human access-list. `email`/`role` are absent — the
   * cast satisfies the read type (Email-Ops `User` has no role column).
   */
  static buildFederationPrincipal(actorClientId: string): User {
    const now = new Date();
    return {
      id: `federation:${actorClientId}`,
      email: null,
      username: `federation:${actorClientId}`,
      firstName: '',
      lastName: '',
      keycloakId: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
      __isFederationActor: true,
      __federationActor: actorClientId,
    } as unknown as User;
  }

  /**
   * Parse EMAIL_OPS_FEDERATION_ACTORS (comma-separated allow-list of actor
   * client-ids permitted to federate, e.g. `customer-ops`). Unset/empty ⇒ no
   * federation actors (safe default). Read each call (like brigadeTrustedIssuers).
   */
  private static federationActors(): readonly string[] {
    const raw = process.env.EMAIL_OPS_FEDERATION_ACTORS;
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
