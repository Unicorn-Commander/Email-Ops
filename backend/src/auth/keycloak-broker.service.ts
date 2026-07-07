import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { AuthService } from './auth.service';
import { decrypt } from '../connected-accounts/crypto';

type IdpAlias = 'google' | 'microsoft';

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
      const parsed = decrypt<{ refresh_token?: string; refreshToken?: string; token?: string }>(raw);
      const token = parsed.refresh_token ?? parsed.refreshToken ?? parsed.token;
      return typeof token === 'string' && token.trim() ? token.trim() : null;
    } catch (err) {
      this.logger.warn(`Failed to decrypt Keycloak refresh token: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Fetch the user's `picture` claim live from Keycloak userinfo (suite avatar
   * spine). Uses the stored KC refresh token → access token → userinfo, so the
   * photo resolves for an already-signed-in user without a re-login. Returns
   * null when no token is stored, the refresh fails, or no picture is set.
   */
  async getUserPicture(user: User): Promise<string | null> {
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
      const picture = this.extractString(payload, ['picture', 'avatar_url']);
      return picture && /^https?:\/\//.test(picture) ? picture : null;
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
    const issuer = this.issuer;
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;
    if (!issuer || !clientId || !clientSecret) {
      return null;
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
        return null;
      }

      const payload = (await res.json()) as Record<string, unknown>;
      const accessToken = this.extractString(payload, ['access_token', 'accessToken']);
      if (!accessToken) {
        return null;
      }
      return {
        accessToken,
        refreshToken: this.extractString(payload, ['refresh_token', 'refreshToken']),
      };
    } catch (err) {
      this.logger.warn(`Keycloak refresh token exchange failed: ${(err as Error).message}`);
      return null;
    }
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
