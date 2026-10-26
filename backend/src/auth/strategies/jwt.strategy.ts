import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import * as jsonwebtoken from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { AuthService, JwtPayload } from '../auth.service';
import { User } from '@prisma/client';
import { isMcpRequest } from '../oauth-discovery/mcp-auth-header';

/**
 * Extract the local session JWT from the HttpOnly `access_token` cookie — the
 * web session's transport. An HttpOnly cookie is not readable by JS, so an XSS
 * can't exfiltrate it the way it could the old localStorage token. Dependency-
 * free (parses the raw Cookie header) so no cookie-parser middleware is needed.
 * Returns null when absent; the Bearer header extractor still serves MCP / PAT /
 * federation callers, so this is purely ADDITIVE.
 */
function cookieTokenExtractor(req: any): string | null {
  const header: string | undefined = req?.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === 'access_token') {
      const value = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

const bearerTokenExtractor = ExtractJwt.fromAuthHeaderAsBearerToken();

/** Cookie sessions serve the UI; MCP must use an Authorization bearer only. */
function sessionOrBearerExtractor(req: any): string | null {
  if (isMcpRequest(req)) return bearerTokenExtractor(req);
  return cookieTokenExtractor(req) || bearerTokenExtractor(req);
}

/**
 * Multi-token JWT strategy (SUITE-IDENTITY §D6).
 *
 * Accepts:
 * 1. Locally-signed HS256 session JWTs (issued by AuthService after the user
 *    logs in via the Keycloak OIDC callback).
 * 2. Keycloak realm-signed RS256 JWTs (a forwarded uchub realm token).
 * 3. Brigade federation broker RS256 JWTs (Brigade-brokered MCP calls).
 *
 * The signing key resolves by `iss` + `alg` inspection at request time:
 *   HS256                            -> ConfigService.get('JWT_SECRET')
 *   RS256 + iss in BRIGADE_TRUSTED   -> Brigade JWKS (per-issuer client)
 *   RS256 (other)                    -> Keycloak realm JWKS
 *
 * A Brigade federation token is bound to a single app by `aud`; Email-Ops only
 * accepts a token minted FOR email-ops (BRIGADE_EXPECTED_AUDIENCE). A token
 * whose `aud` is some other app is rejected even if its signature + issuer
 * verify — the cross-app fence in SUITE-IDENTITY §9.4 / §1 (aud=email-ops).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);
  private readonly jwks?: JwksClient;
  private readonly realmIssuer: string | null;
  private readonly brigadeTrustedIssuers: Set<string>;
  private readonly brigadeExpectedAudience: string;
  private readonly keycloakEnforceAudience: boolean;
  private readonly keycloakExpectedAudiences: Set<string>;

  constructor(
    configService: ConfigService,
    private authService: AuthService,
  ) {
    const localSecret = configService.get<string>('JWT_SECRET') || '';
    const realmJwksUri = JwtStrategy.buildJwksUri(configService);
    const realmIssuer = JwtStrategy.buildRealmIssuer(configService);
    const brigadeJwksByIss = JwtStrategy.buildBrigadeJwksClients(configService);
    // Audience-binding input: Email-Ops only accepts a federation token minted
    // FOR email-ops. (SUITE-IDENTITY §1: aud=email-ops.)
    const brigadeExpectedAudience =
      configService.get<string>('BRIGADE_EXPECTED_AUDIENCE') || 'email-ops';
    const keycloakEnforceAudience = JwtStrategy.readBoolEnv(
      configService.get<string>('KEYCLOAK_ENFORCE_AUDIENCE'),
      false,
    );
    const keycloakExpectedAudiences = JwtStrategy.buildKeycloakExpectedAudiences(configService);

    let jwks: JwksClient | undefined;
    if (realmJwksUri) {
      jwks = jwksClient({
        jwksUri: realmJwksUri,
        cache: true,
        cacheMaxAge: 10 * 60 * 1000, // 10 minutes
        rateLimit: true,
        jwksRequestsPerMinute: 12,
      });
    }

    super({
      jwtFromRequest: sessionOrBearerExtractor,
      ignoreExpiration: false,
      algorithms: ['HS256', 'RS256'],
      // secretOrKeyProvider runs per-request; inspect the JWT header + payload
      // and resolve the right key on the fly. Provider must call done(err, key).
      secretOrKeyProvider: (
        _request: any,
        rawJwtToken: any,
        done: (err: any, secretOrKey?: string | Buffer) => void,
      ) => {
        try {
          const token =
            typeof rawJwtToken === 'string' ? rawJwtToken : (rawJwtToken?.toString?.() ?? '');
          const decoded: any = jsonwebtoken.decode(token, { complete: true });
          const alg = decoded?.header?.alg;
          const kid = decoded?.header?.kid;
          const iss = AuthService.normalizeIssuer(decoded?.payload?.iss);

          // A token claiming the configured Keycloak issuer must be the
          // asymmetric realm token; never allow the local HS256 secret to
          // validate a forged realm-shaped payload.
          if (realmIssuer && iss === realmIssuer && alg !== 'RS256') {
            done(new Error('Keycloak tokens must use RS256'));
            return;
          }

          // RS256 + Brigade-trusted-issuer -> per-issuer Brigade JWKS
          if (alg === 'RS256' && kid && iss && brigadeJwksByIss.has(iss)) {
            const client = brigadeJwksByIss.get(iss)!;
            client.getSigningKey(kid, (err, key) => {
              if (err || !key) {
                done(err || new Error('Brigade signing key not found'));
                return;
              }
              done(null, key.getPublicKey());
            });
            return;
          }

          // RS256 + valid kid + the configured issuer -> Keycloak realm JWKS.
          if (alg === 'RS256' && kid && iss === realmIssuer && jwks) {
            jwks.getSigningKey(kid, (err, key) => {
              if (err || !key) {
                done(err || new Error('signing key not found'));
                return;
              }
              done(null, key.getPublicKey());
            });
            return;
          }
          if (alg === 'RS256') {
            done(new Error('Untrusted RS256 issuer or missing signing key'));
            return;
          }
          if (alg !== 'HS256') {
            done(new Error('Unsupported JWT algorithm'));
            return;
          }
          // Local sessions are the only HS256 branch.
          done(null, localSecret);
        } catch (err) {
          done(err);
        }
      },
    });

    this.jwks = jwks;
    this.realmIssuer = realmIssuer;
    this.brigadeTrustedIssuers = new Set(brigadeJwksByIss.keys());
    this.brigadeExpectedAudience = brigadeExpectedAudience;
    this.keycloakEnforceAudience = keycloakEnforceAudience;
    this.keycloakExpectedAudiences = keycloakExpectedAudiences;

    if (realmJwksUri) {
      this.logger.log(`Keycloak realm JWT validation enabled via ${realmJwksUri}`);
    } else {
      this.logger.log(
        'Keycloak realm JWT validation disabled (KEYCLOAK_URL/KEYCLOAK_REALM not set)',
      );
    }
    if (brigadeJwksByIss.size > 0) {
      this.logger.log(
        `Brigade federation JWT validation enabled for ${brigadeJwksByIss.size} issuer(s): ${[...brigadeJwksByIss.keys()].join(', ')}`,
      );
    } else {
      this.logger.log('Brigade federation JWT validation disabled (BRIGADE_TRUSTED_ISSUERS unset)');
    }
  }

  private static buildJwksUri(config: ConfigService): string | null {
    const base = (config.get<string>('KEYCLOAK_URL') || '').replace(/\/$/, '');
    const realm = config.get<string>('KEYCLOAK_REALM');
    if (!base || !realm) return null;
    return `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`;
  }

  private static buildRealmIssuer(config: ConfigService): string | null {
    const base = (config.get<string>('KEYCLOAK_URL') || '').replace(/\/+$/, '');
    const realm = config.get<string>('KEYCLOAK_REALM');
    if (!base || !realm) return null;
    return AuthService.normalizeIssuer(`${base}/realms/${encodeURIComponent(realm)}`);
  }

  private static readBoolEnv(value: string | undefined, fallback: boolean): boolean {
    if (value == null || value.trim() === '') return fallback;
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    return fallback;
  }

  /** Accepted Keycloak audiences are the app client plus configured extras. */
  private static buildKeycloakExpectedAudiences(config: ConfigService): Set<string> {
    const clientId = (config.get<string>('KEYCLOAK_CLIENT_ID') || 'email-ops').trim();
    const raw = config.get<string>('KEYCLOAK_EXPECTED_AUDIENCES');
    const set = new Set<string>([clientId || 'email-ops']);
    for (const audience of (raw || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      set.add(audience);
    }
    return set;
  }

  /**
   * Build a per-issuer JWKS client map from BRIGADE_TRUSTED_ISSUERS. Each
   * issuer's JWKS is fetched from `<iss>/.well-known/jwks.json` by convention
   * (matches the Brigade federation spec). Default is the customer-facing prod
   * broker. Set the env to "" to disable.
   */
  private static buildBrigadeJwksClients(config: ConfigService): Map<string, JwksClient> {
    const raw = config.get<string>('BRIGADE_TRUSTED_ISSUERS');
    const source = raw === undefined || raw === null ? 'https://brigade.unicorncommander.ai' : raw;
    const issuers = source
      .split(',')
      .map((s) => AuthService.normalizeIssuer(s))
      .filter((s): s is string => !!s);

    const map = new Map<string, JwksClient>();
    for (const iss of issuers) {
      map.set(
        iss,
        jwksClient({
          jwksUri: `${iss}/.well-known/jwks.json`,
          cache: true,
          cacheMaxAge: 10 * 60 * 1000, // 10 minutes
          rateLimit: true,
          jwksRequestsPerMinute: 12,
        }),
      );
    }
    return map;
  }

  /**
   * Audience-binding check. A federation token minted for another app
   * (`aud=accounting-ops`, etc.) MUST be rejected by Email-Ops even though its
   * signature + issuer verify — the cross-app fence (SUITE-IDENTITY §9.4).
   * `aud` may be a string or an array (RFC 7519).
   */
  static audienceMatches(aud: unknown, expected: string): boolean {
    if (Array.isArray(aud)) return aud.includes(expected);
    return aud === expected;
  }

  /** Match Keycloak's client identity in either `azp` or `aud`. */
  static keycloakAudienceMatches(aud: unknown, azp: unknown, expected: Set<string>): boolean {
    if (typeof azp === 'string' && expected.has(azp)) return true;
    if (typeof aud === 'string' && expected.has(aud)) return true;
    if (Array.isArray(aud)) {
      return aud.some((value) => typeof value === 'string' && expected.has(value));
    }
    return false;
  }

  private static hasValidExpiration(exp: unknown): boolean {
    return typeof exp === 'number' && Number.isFinite(exp) && exp > Math.floor(Date.now() / 1000);
  }

  private static claimForLog(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(',');
    return '';
  }

  /**
   * Extract the flat entitlement SKU list from a verified token, tolerant of how
   * the claim eventually lands (mirrors AO's `_read_entitlements` shapes, first
   * non-empty wins):
   *   1. `entitlements` — array OR space/comma-separated string of SKUs.
   *   2. `products`     — same idea under a different key.
   *   3. `subscription.products` / `subscription.entitlements` (nested).
   * Items may be plain strings or `{code|product|sku, active?}` objects. Returns
   * a de-duplicated string[] (raw — the entitlement gate normalizes/aliases).
   */
  static readEntitlements(payload: any): string[] {
    const coerce = (value: unknown): string[] => {
      if (value == null) return [];
      if (typeof value === 'string') {
        return value
          .replace(/,/g, ' ')
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (Array.isArray(value)) {
        const out: string[] = [];
        for (const item of value) {
          if (typeof item === 'string') {
            const t = item.trim();
            if (t) out.push(t);
          } else if (item && typeof item === 'object') {
            const code = (item as any).code ?? (item as any).product ?? (item as any).sku;
            const active = (item as any).active ?? true;
            if (code && active) out.push(String(code).trim());
          }
        }
        return out;
      }
      return [];
    };

    let codes = coerce(payload?.entitlements);
    if (codes.length === 0) codes = coerce(payload?.products);
    if (codes.length === 0 && payload?.subscription && typeof payload.subscription === 'object') {
      codes = coerce(payload.subscription.products ?? payload.subscription.entitlements);
    }
    return [...new Set(codes)];
  }

  async validate(payload: any): Promise<User> {
    try {
      // Any token whose `iss` is a trusted Brigade broker is a federation token:
      // enforce that its audience is THIS app before resolving the user. (Local
      // HS256 + Keycloak-realm tokens have a non-Brigade `iss` and carry no
      // app-scoped `aud`, so they are unaffected.)
      const issuer = AuthService.normalizeIssuer(payload?.iss);
      if (issuer && this.brigadeTrustedIssuers.has(issuer)) {
        if (!JwtStrategy.audienceMatches(payload?.aud, this.brigadeExpectedAudience)) {
          this.logger.warn(
            `Rejected Brigade token: aud=${JSON.stringify(payload?.aud)} != ${this.brigadeExpectedAudience}`,
          );
          throw new UnauthorizedException('Token audience is not email-ops');
        }
      } else if (issuer && issuer.includes('/realms/')) {
        if (!this.realmIssuer || issuer !== this.realmIssuer) {
          this.logger.warn('Rejected Keycloak realm token: issuer is not the configured realm');
          throw new UnauthorizedException('Token issuer is not authorized');
        }
        if (!JwtStrategy.hasValidExpiration(payload?.exp)) {
          throw new UnauthorizedException('Keycloak token is expired or missing exp');
        }
        const audienceMatches = JwtStrategy.keycloakAudienceMatches(
          payload?.aud,
          payload?.azp,
          this.keycloakExpectedAudiences,
        );
        if (this.keycloakEnforceAudience && !audienceMatches) {
          this.logger.warn(
            `Rejected Keycloak token audience: azp=${JwtStrategy.claimForLog(payload?.azp)} aud=${JwtStrategy.claimForLog(payload?.aud)}`,
          );
          throw new UnauthorizedException('Token is not authorized for email-ops');
        }
        // Keep this log limited to the client/audience names. It is the
        // evidence stream for the temporary log-only migration period.
        this.logger.log(
          `Accepted Keycloak token: azp=${JwtStrategy.claimForLog(payload?.azp)} aud=${JwtStrategy.claimForLog(payload?.aud)}`,
        );
      }

      const user = await this.authService.validateJwtPayload(payload as JwtPayload);
      // Surface the suite-canonical workspace/tenant claim + acting sub on the
      // resolved user so the tenancy seam (WorkspaceContextService /
      // @CurrentWorkspace) can scope rows without trusting an HTTP header.
      if ((issuer && this.brigadeTrustedIssuers.has(issuer)) || payload?.act) {
        (user as User & { __isFederationAuth?: boolean }).__isFederationAuth = true;
      }
      const augmented = user as User & {
        __workspaceClaim?: string | null;
        __ucUid?: string | null;
        __entitlements?: string[] | null;
      };
      augmented.__workspaceClaim = payload?.workspace_id ?? payload?.tenant_id ?? null;
      // Local session tokens use the local User.id as `sub`, while MCP and
      // Keycloak identities use the stable Keycloak subject. New local tokens
      // carry that subject explicitly; for older local tokens, the resolved
      // user supplies the same key before falling back to the token subject.
      augmented.__ucUid =
        (typeof payload?.uc_uid === 'string' && payload.uc_uid.trim() ? payload.uc_uid : null) ??
        user.keycloakId ??
        (typeof payload?.sub === 'string' ? payload.sub : null);
      // The verified entitlement SKUs (the compose dual-SKU gate reads these).
      // Read from the flat `entitlements`/`products` claim (or nested
      // subscription.products) and normalized to a string[]; never an HTTP
      // header — this rides only on the cryptographically-verified token.
      augmented.__entitlements = JwtStrategy.readEntitlements(payload);
      return user;
    } catch (error) {
      this.logger.warn(`JWT validation failed: ${(error as Error).message ?? 'unknown'}`);
      // Preserve an explicit audience rejection as-is; collapse the rest.
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid token');
    }
  }
}
