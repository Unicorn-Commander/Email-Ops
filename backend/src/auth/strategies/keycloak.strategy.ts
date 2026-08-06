import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-oauth2';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

/**
 * Keycloak OIDC (Authorization Code) strategy for the browser login flow.
 * Redirects the user to the uchub realm, then on callback fetches the userinfo
 * and JIT-provisions / resolves the Email-Ops User via AuthService.
 */
@Injectable()
export class KeycloakStrategy extends PassportStrategy(Strategy, 'keycloak') {
  private readonly logger = new Logger(KeycloakStrategy.name);
  private readonly userinfoURL: string;

  constructor(
    private configService: ConfigService,
    private authService: AuthService,
  ) {
    const keycloakUrl = configService.get('KEYCLOAK_URL', 'https://auth.unicorncommander.ai');
    const realm = configService.get('KEYCLOAK_REALM', 'uchub');
    const callbackURL = configService.get(
      'KEYCLOAK_CALLBACK_URL',
      '/api/v1/auth/keycloak/callback',
    );

    super({
      authorizationURL: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/auth`,
      tokenURL: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/token`,
      clientID: configService.get('KEYCLOAK_CLIENT_ID', 'email-ops'),
      clientSecret: configService.get('KEYCLOAK_CLIENT_SECRET', ''),
      callbackURL,
      // Behind Traefik, TLS terminates at the proxy and the app sees plain http.
      // `proxy: true` makes passport-oauth2 build the (relative) callbackURL from
      // X-Forwarded-Proto/Host, so the redirect_uri is https — matching the
      // value registered on the Keycloak client. (Requires `trust proxy` set.)
      proxy: true,
      scope: ['openid', 'profile', 'email', 'offline_access'],
    });

    this.userinfoURL = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/userinfo`;
  }

  async validate(accessToken: string, refreshToken: string, profile: any): Promise<any> {
    // passport-oauth2 does not fetch userinfo automatically, so we call the
    // Keycloak userinfo endpoint to get the full profile (sub, email, names).
    let userProfile = profile;
    try {
      const response = await fetch(this.userinfoURL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        userProfile = await response.json();
      } else {
        this.logger.warn(
          `Failed to fetch userinfo from Keycloak: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      this.logger.error('Error fetching Keycloak userinfo', error as Error);
    }

    const keycloakId = userProfile.sub || userProfile.id;
    const user = await this.authService.validateKeycloakUser(keycloakId, userProfile);
    await this.authService.storeKcRefreshToken(user, refreshToken);
    return user;
  }
}
