import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { resolveUserAccess, describeAccessList } from './access-list';

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
   *   2. by email — links an existing local row to this sub (sets keycloakId).
   *   3. neither — JIT-create, GATED by the access list.
   */
  async validateKeycloakUser(keycloakId: string, profile: any): Promise<User> {
    const email: string | undefined = profile?.email;

    // 1. keycloakId / sub first.
    let user = await this.prisma.user.findUnique({ where: { keycloakId } });

    // 2. email linking fallback.
    if (!user && email) {
      user = await this.prisma.user.findUnique({ where: { email } });
      if (user) {
        user = await this.prisma.user.update({ where: { id: user.id }, data: { keycloakId } });
        this.logger.log(`Linked existing user ${email} to Keycloak sub ${keycloakId}`);
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

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
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
   * Disambiguate a verified JWT payload by its `iss` claim and resolve the
   * Email-Ops User (SUITE-IDENTITY §D6):
   *   - Keycloak realm token (`iss` has `/realms/`) OR Brigade federation token
   *     (`iss` in BRIGADE_TRUSTED_ISSUERS) → reuse the access-list-gated
   *     validateKeycloakUser path. No path auto-provisions outside the gate.
   *   - Locally-signed session token (no/foreign `iss`) → resolve by local id.
   */
  async validateJwtPayload(payload: any): Promise<User> {
    const issuer: string | undefined = payload?.iss;
    const isKeycloakRealmToken = typeof issuer === 'string' && issuer.includes('/realms/');
    const isBrigadeFederationToken =
      typeof issuer === 'string' && AuthService.brigadeTrustedIssuers().includes(issuer);

    if (isKeycloakRealmToken || isBrigadeFederationToken) {
      // Brigade's transitional sub may be an email; surface it as the profile
      // email so the access-list + email-link path still resolves. Harmless for
      // Keycloak realm tokens (which DO emit email) and for the long-term
      // opaque-sub Brigade model (Brigade emits email separately then).
      const subLooksLikeEmail = typeof payload.sub === 'string' && payload.sub.includes('@');
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
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
