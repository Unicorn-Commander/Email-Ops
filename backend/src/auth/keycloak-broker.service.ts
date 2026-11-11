import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { AuthService } from './auth.service';
import { avatarUrlFromClaims } from './avatar-url';
import { decrypt } from '../connected-accounts/crypto';

type IdpAlias = 'google' | 'microsoft';

export type BrokerUnlinkReason = 'no_session' | 'broker_down' | 'rejected';

/**
 * Result of removing one identity-broker link for the user who owns the
 * stored Keycloak refresh token. Remaining aliases are the links still on
 * that same user, or null when the account list could not be read.
 */
export type BrokerUnlinkResult =
  | { ok: true; alreadyAbsent: boolean; remainingAliases: string[] | null }
  | { ok: false; reason: BrokerUnlinkReason };

@Injectable()
export class KeycloakBrokerService {
  private readonly logger = new Logger(KeycloakBrokerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async getProviderAccessToken(user: User, alias: IdpAlias): Promise<string | null> {
    const refreshToken = this.loadRefreshToken(user.kcRefreshTokenEnc);
    if (!refreshToken) {
      return null;
    }

    const refreshResult = await this.refreshKeycloakAccessToken(refreshToken);
    if (!refreshResult) {
      return null;
    }

    if (refreshResult.refreshToken) {
      await this.authService.storeKcRefreshToken(user, refreshResult.refreshToken);
    }

    return this.fetchBrokerToken(refreshResult.accessToken, alias);
  }

  /**
   * Build a Keycloak "client-initiated account linking" URL so a logged-in user
   * can link an additional IdP (google/microsoft) to their EXISTING uchub
   * identity from inside the app — the on-model alternative to a per-app OAuth
   * client. The browser must carry the user's active KC SSO session cookie; the
   * signed hash binds the request to that session
   * (hash = Base64Url(SHA256(nonce + session_state + clientId + provider))).
   * Returns null if it can't be minted (no stored token / refresh failed /
   * no session_state) — the caller surfaces a re-auth hint.
   */
  async buildAccountLinkUrl(
    user: User,
    alias: IdpAlias,
    redirectUri: string,
  ): Promise<string | null> {
    const refreshToken = this.loadRefreshToken(user.kcRefreshTokenEnc);
    if (!refreshToken) return null;

    const refreshed = await this.refreshKeycloakAccessToken(refreshToken);
    if (!refreshed) return null;
    if (refreshed.refreshToken) {
      await this.authService.storeKcRefreshToken(user, refreshed.refreshToken);
    }

    const sessionState = this.sessionStateOf(refreshed.accessToken);
    const issuer = this.issuer;
    const clientId = this.clientId;
    if (!sessionState || !issuer || !clientId) return null;

    const nonce = randomUUID();
    const hash = createHash('sha256')
      .update(`${nonce}${sessionState}${clientId}${alias}`, 'utf8')
      .digest('base64url');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      nonce,
      hash,
    });
    return `${issuer}/broker/${alias}/link?${params.toString()}`;
  }

  /**
   * Remove one brokered IdP (google or microsoft) from the signed-in user.
   * Uses that user's stored Keycloak refresh token, the same confidential
   * client the link flow already uses, and Keycloak's account API. The
   * bearer token is the user's own access token, so the call can only
   * unlink the account that token belongs to.
   */
  async unlinkBrokerIdentity(user: User, alias: IdpAlias): Promise<BrokerUnlinkResult> {
    const refreshToken = this.loadRefreshToken(user.kcRefreshTokenEnc);
    if (!refreshToken) return { ok: false, reason: 'no_session' };

    const refreshed = await this.refreshKeycloakAccessTokenDetailed(refreshToken);
    if (!refreshed.ok) return { ok: false, reason: refreshed.reason };
    if (refreshed.refreshToken) {
      await this.authService.storeKcRefreshToken(user, refreshed.refreshToken);
    }

    const issuer = this.issuer;
    if (!issuer) return { ok: false, reason: 'broker_down' };

    const deleteUrl = `${issuer}/account/linked-accounts/${encodeURIComponent(alias)}`;
    let deleted: Response;
    try {
      deleted = await this.fetchWithTimeout(deleteUrl, {
        method: 'DELETE',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${refreshed.accessToken}`,
        },
      });
    } catch (err) {
      this.logger.warn(`Keycloak broker unlink failed for ${alias}: ${(err as Error).name}`);
      return { ok: false, reason: 'broker_down' };
    }

    if (deleted.status >= 300 && deleted.status < 400) {
      this.logger.warn(
        `Keycloak broker unlink redirected for ${alias} with HTTP ${deleted.status}`,
      );
      return { ok: false, reason: 'broker_down' };
    }

    if (deleted.status >= 200 && deleted.status < 300) {
      const remainingAliases = await this.readRemainingLinkedAliases(issuer, refreshed.accessToken);
      return { ok: true, alreadyAbsent: false, remainingAliases };
    }

    if (deleted.status === 401 || deleted.status === 403) {
      this.logger.warn(`Keycloak broker unlink rejected for ${alias} with HTTP ${deleted.status}`);
      return { ok: false, reason: 'rejected' };
    }

    // Keycloak answers 400 when the alias is not linked, and also when it
    // refuses (for example the last sign-in method). Confirm with the list
    // before treating the link as already gone.
    if (deleted.status === 400 || deleted.status === 404) {
      const remainingAliases = await this.readRemainingLinkedAliases(issuer, refreshed.accessToken);
      if (remainingAliases === null || remainingAliases.includes(alias)) {
        this.logger.warn(
          `Keycloak broker unlink for ${alias} returned HTTP ${deleted.status} and the link is still present or unreadable`,
        );
        return { ok: false, reason: 'rejected' };
      }
      return { ok: true, alreadyAbsent: true, remainingAliases };
    }

    this.logger.warn(`Keycloak broker unlink failed for ${alias} with HTTP ${deleted.status}`);
    return { ok: false, reason: 'broker_down' };
  }

  /** Read the SSO session id from a KC access token (no signature check needed —
   *  it came straight from KC over TLS, and a wrong value just fails the link). */
  private sessionStateOf(accessToken: string): string | null {
    try {
      const part = accessToken.split('.')[1];
      if (!part) return null;
      const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8')) as Record<
        string,
        unknown
      >;
      const ss = payload['session_state'] ?? payload['sid'];
      return typeof ss === 'string' && ss ? ss : null;
    } catch {
      return null;
    }
  }

  private loadRefreshToken(encrypted?: string | null): string | null {
    const raw = encrypted?.trim();
    if (!raw) {
      return null;
    }
    try {
      const parsed = decrypt<{ refresh_token?: string; refreshToken?: string; token?: string }>(
        raw,
      );
      const token = parsed.refresh_token ?? parsed.refreshToken ?? parsed.token;
      return typeof token === 'string' && token.trim() ? token.trim() : null;
    } catch (err) {
      this.logger.warn(`Failed to decrypt Keycloak refresh token: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Fetch the user's avatar claim live from Keycloak userinfo (suite avatar
   * spine). Uses the stored KC refresh token → access token → userinfo, so the
   * photo resolves for an already-signed-in user without a re-login. Returns
   * null when no token is stored, the refresh fails, or no avatar is set.
   */
  async getUserAvatarUrl(user: User): Promise<string | null> {
    const refreshToken = this.loadRefreshToken(user.kcRefreshTokenEnc);
    if (!refreshToken) return null;

    const refreshed = await this.refreshKeycloakAccessToken(refreshToken);
    if (!refreshed) return null;
    if (refreshed.refreshToken) {
      await this.authService.storeKcRefreshToken(user, refreshed.refreshToken);
    }

    const issuer = this.issuer;
    if (!issuer) return null;

    try {
      const res = await this.fetchWithTimeout(`${issuer}/protocol/openid-connect/userinfo`, {
        headers: { Authorization: `Bearer ${refreshed.accessToken}` },
      });
      if (!res.ok) {
        this.logger.warn(`Keycloak userinfo fetch failed with HTTP ${res.status}`);
        return null;
      }
      const payload = (await res.json()) as Record<string, unknown>;
      return avatarUrlFromClaims(payload);
    } catch (err) {
      this.logger.warn(`Keycloak userinfo fetch failed: ${(err as Error).message}`);
      return null;
    }
  }

  private get issuer(): string | null {
    const url = this.config.get<string>('KEYCLOAK_URL');
    const realm = this.config.get<string>('KEYCLOAK_REALM', 'uchub');
    const base = url?.trim();
    const realmName = realm?.trim();
    if (!base || !realmName) return null;
    return `${base.replace(/\/$/, '')}/realms/${realmName}`;
  }

  private get clientId(): string | null {
    const raw = this.config.get<string>('KEYCLOAK_CLIENT_ID');
    return raw?.trim() || null;
  }

  private get clientSecret(): string | null {
    const raw = this.config.get<string>('KEYCLOAK_CLIENT_SECRET');
    return raw?.trim() || null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('KEYCLOAK_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  private async refreshKeycloakAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string | null } | null> {
    const detailed = await this.refreshKeycloakAccessTokenDetailed(refreshToken);
    if (!detailed.ok) return null;
    return { accessToken: detailed.accessToken, refreshToken: detailed.refreshToken };
  }

  private async refreshKeycloakAccessTokenDetailed(
    refreshToken: string,
  ): Promise<
    | { ok: true; accessToken: string; refreshToken: string | null }
    | { ok: false; reason: BrokerUnlinkReason }
  > {
    const issuer = this.issuer;
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;
    if (!issuer || !clientId || !clientSecret) {
      return { ok: false, reason: 'broker_down' };
    }

    try {
      const res = await this.fetchWithTimeout(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Keycloak refresh token exchange failed with HTTP ${res.status}`);
        if (res.status === 400 || res.status === 401) return { ok: false, reason: 'no_session' };
        if (res.status === 403) return { ok: false, reason: 'rejected' };
        return { ok: false, reason: 'broker_down' };
      }

      const payload = (await res.json()) as Record<string, unknown>;
      const accessToken = this.extractString(payload, ['access_token', 'accessToken']);
      if (!accessToken) {
        return { ok: false, reason: 'broker_down' };
      }
      return {
        ok: true,
        accessToken,
        refreshToken: this.extractString(payload, ['refresh_token', 'refreshToken']),
      };
    } catch (err) {
      this.logger.warn(`Keycloak refresh token exchange failed: ${(err as Error).message}`);
      return { ok: false, reason: 'broker_down' };
    }
  }

  /** Linked IdP aliases for the bearer token's user, or null if the list failed. */
  private async readRemainingLinkedAliases(
    issuer: string,
    accessToken: string,
  ): Promise<string[] | null> {
    try {
      const res = await this.fetchWithTimeout(`${issuer}/account/linked-accounts?linked=true`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (res.status < 200 || res.status >= 300) {
        this.logger.warn(`Keycloak linked-account list failed with HTTP ${res.status}`);
        return null;
      }
      const payload = (await res.json()) as unknown;
      return this.connectedAliases(payload);
    } catch (err) {
      this.logger.warn(`Keycloak linked-account list failed: ${(err as Error).name}`);
      return null;
    }
  }

  private connectedAliases(payload: unknown): string[] {
    if (!Array.isArray(payload)) return [];
    const aliases: string[] = [];
    for (const row of payload) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const alias = record.providerAlias ?? record.providerName;
      if (typeof alias !== 'string' || !alias.trim()) continue;
      if (record.connected === false) continue;
      aliases.push(alias.trim());
    }
    return aliases;
  }

  private async fetchBrokerToken(accessToken: string, alias: IdpAlias): Promise<string | null> {
    const issuer = this.issuer;
    if (!issuer) {
      return null;
    }

    try {
      const res = await this.fetchWithTimeout(`${issuer}/broker/${alias}/token`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        this.logger.warn(`Keycloak broker token fetch failed with HTTP ${res.status}`);
        return null;
      }

      const text = (await res.text()).trim();
      if (!text) return null;

      if (text.startsWith('{') || text.startsWith('[')) {
        try {
          const payload = JSON.parse(text) as Record<string, unknown>;
          const token = this.extractString(payload, ['access_token', 'token', 'accessToken']);
          return token ?? null;
        } catch {
          return null;
        }
      }

      return text;
    } catch (err) {
      this.logger.warn(`Keycloak broker token fetch failed: ${(err as Error).message}`);
      return null;
    }
  }

  private extractString(payload: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }
}
