import { All, Controller, INestApplication, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { AuthService } from '../auth.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { JwtStrategy } from '../strategies/jwt.strategy';
import { PatService } from '../pat.service';
import { createMcpCorsMiddleware } from './mcp-cors';
import { OAuthDiscoveryController } from './oauth-discovery.controller';
import { OAuthDiscoveryService } from './oauth-discovery.service';

let jwksPublicKey = '';

jest.mock('jwks-rsa', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getSigningKey: (_kid: string, callback: (error: Error | null, key?: any) => void) =>
      callback(null, { getPublicKey: () => jwksPublicKey }),
  })),
}));

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
jwksPublicKey = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const localSecret = 'synthetic-local-secret-for-oauth-tests';
const realmIssuer = 'https://auth.example.test/realms/uchub';

@Controller('mcp')
class McpProbeController {
  @All()
  @UseGuards(JwtAuthGuard)
  handle(@Req() request: any) {
    return { ok: Boolean(request.user) };
  }
}

type HttpResult = {
  status: number;
  headers: Record<string, string>;
  body: any;
};

let baseUrl = '';

async function httpRequest(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: options.headers,
    body: options.body,
  });
  const text = await response.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body };
}

function mcpBody(): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
}

describe('Email-Ops MCP OAuth discovery and resource-server boundary', () => {
  let app: INestApplication;
  const configValues: Record<string, string | undefined> = {
    JWT_SECRET: localSecret,
    BRIGADE_TRUSTED_ISSUERS: '',
    KEYCLOAK_URL: 'https://auth.example.test',
    KEYCLOAK_REALM: 'uchub',
    KEYCLOAK_CLIENT_ID: 'email-ops',
    KEYCLOAK_ENFORCE_AUDIENCE: 'true',
    CORS_ORIGIN: 'https://portal.example.test',
    FRONTEND_URL: 'https://portal.example.test',
    MCP_CORS_ORIGINS: 'https://allowed.example.test',
    EMAIL_OPS_PUBLIC_BASE_URL: 'https://email-ops.example.test',
  };
  const config = {
    get: <T>(key: string, fallback?: T) => (configValues[key] ?? fallback) as T,
  } as unknown as ConfigService;
  const authService = {
    validateJwtPayload: jest.fn().mockResolvedValue({
      id: 'fictional-user',
      email: 'tester@example.test',
      keycloakId: 'fictional-sub',
      isActive: true,
    }),
  } as unknown as AuthService;
  const patService = {
    resolvePatRecord: jest.fn(async () => null),
  } as unknown as PatService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [OAuthDiscoveryController, McpProbeController],
      providers: [
        OAuthDiscoveryService,
        JwtStrategy,
        JwtAuthGuard,
        { provide: ConfigService, useValue: config },
        { provide: PatService, useValue: patService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(createMcpCorsMiddleware(config));
    app.enableCors({
      origin: 'https://portal.example.test',
      credentials: true,
    });
    app.setGlobalPrefix('api/v1', {
      exclude: [
        '.well-known/oauth-protected-resource',
        '.well-known/oauth-protected-resource/api/v1/mcp',
      ],
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves both RFC 9728 metadata paths without auth and with cache/CORS headers', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/v1/mcp',
    ]) {
      const response = await httpRequest(path, {
        headers: { Origin: 'https://outside.example.test' },
      });
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      expect(Object.keys(response.body)).toEqual(
        expect.arrayContaining([
          'resource',
          'authorization_servers',
          'bearer_methods_supported',
          'scopes_supported',
          'resource_name',
          'resource_documentation',
        ]),
      );
      expect(response.body.resource).toBe('https://email-ops.example.test/api/v1/mcp');
      expect(response.body.authorization_servers).toEqual([realmIssuer]);
      // Clients request exactly these; Keycloak's DCR policy refuses any other scope, and `mcp` carries the audience.
      expect(response.body.scopes_supported).toEqual([
        'openid',
        'profile',
        'email',
        'offline_access',
        'mcp',
      ]);
    }
  });

  it('answers OPTIONS for both RFC 9728 metadata paths without auth', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/v1/mcp',
    ]) {
      const response = await httpRequest(path, {
        method: 'OPTIONS',
        headers: { Origin: 'https://outside.example.test' },
      });
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
    }
  });

  it('answers MCP preflight before auth and carries the Streamable HTTP header contract', async () => {
    const response = await httpRequest('/api/v1/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example.test',
        'Access-Control-Request-Headers': 'Authorization, Mcp-Session-Id',
      },
    });
    expect(response.status).toBe(204);

    expect(response.headers['access-control-allow-origin']).toBe('https://allowed.example.test');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['access-control-allow-headers']).toContain('Authorization');
    expect(response.headers['access-control-allow-headers']).toContain('Mcp-Session-Id');
    expect(response.headers['access-control-allow-headers']).toContain('Mcp-Protocol-Version');
    expect(response.headers['access-control-allow-headers']).toContain('Last-Event-ID');
    expect(response.headers['access-control-expose-headers']).toBe('Mcp-Session-Id');
  });

  it('rejects an MCP browser request from a disallowed origin before auth', async () => {
    const response = await httpRequest('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Origin: 'https://outside.example.test',
        Authorization: 'Bearer invalid-browser-credential',
        'Content-Type': 'application/json',
      },
      body: mcpBody(),
    });
    expect(response.status).toBe(403);

    expect(response.body).toEqual({ error: 'origin_not_allowed' });
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  it('returns the discovery challenge for a missing bearer', async () => {
    const response = await httpRequest('/api/v1/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: mcpBody(),
    });
    expect(response.status).toBe(401);

    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="email-ops-mcp", resource_metadata="https://email-ops.example.test/.well-known/oauth-protected-resource/api/v1/mcp"',
    );
    expect(JSON.stringify(response.body)).not.toContain('invalid-browser-credential');
  });

  it('returns invalid_token discovery for a malformed bearer', async () => {
    const response = await httpRequest('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer malformed-credential',
        'Content-Type': 'application/json',
      },
      body: mcpBody(),
    });
    expect(response.status).toBe(401);

    expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(JSON.stringify(response.body)).not.toContain('malformed-credential');
  });

  it('accepts a signed Keycloak token with the configured azp and aud/exp/iss claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: 'fictional-sub',
        email: 'tester@example.test',
        iss: realmIssuer,
        azp: 'email-ops',
        aud: 'account',
        iat: now - 10,
        exp: now + 300,
      },
      keyPair.privateKey,
      { algorithm: 'RS256', keyid: 'synthetic-jwks-key' },
    );
    const response = await httpRequest('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: mcpBody(),
    });
    expect(response.status).toBe(200);

    expect(response.body).toEqual({ ok: true });
    expect(authService.validateJwtPayload).toHaveBeenCalled();
  });

  it('rejects a signed Keycloak token with a wrong issuer or expired exp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongIssuer = jwt.sign(
      {
        sub: 'fictional-sub',
        email: 'tester@example.test',
        iss: 'https://other.example.test/realms/uchub',
        azp: 'email-ops',
        iat: now - 10,
        exp: now + 300,
      },
      keyPair.privateKey,
      { algorithm: 'RS256', keyid: 'synthetic-jwks-key' },
    );
    const wrongIssuerResponse = await httpRequest('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${wrongIssuer}`,
        'Content-Type': 'application/json',
      },
      body: mcpBody(),
    });
    expect(wrongIssuerResponse.status).toBe(401);

    const expired = jwt.sign(
      {
        sub: 'fictional-sub',
        email: 'tester@example.test',
        iss: realmIssuer,
        azp: 'email-ops',
        iat: now - 600,
        exp: now - 300,
      },
      keyPair.privateKey,
      { algorithm: 'RS256', keyid: 'synthetic-jwks-key' },
    );
    const expiredResponse = await httpRequest('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${expired}`,
        'Content-Type': 'application/json',
      },
      body: mcpBody(),
    });
    expect(expiredResponse.status).toBe(401);
  });

  it('rejects a signed Keycloak token with a wrong audience when enforcement is enabled', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: 'fictional-sub',
        email: 'tester@example.test',
        iss: realmIssuer,
        azp: 'sibling-app',
        aud: 'account',
        iat: now - 10,
        exp: now + 300,
      },
      keyPair.privateKey,
      { algorithm: 'RS256', keyid: 'synthetic-jwks-key' },
    );
    const response = await httpRequest('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: mcpBody(),
    });
    expect(response.status).toBe(401);

    expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('does not use a browser cookie/session to authenticate the MCP path', async () => {
    const cookie = jwt.sign({ sub: 'fictional-user' }, localSecret, { expiresIn: '5m' });
    const response = await httpRequest('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Cookie: `access_token=${cookie}`,
        'Content-Type': 'application/json',
      },
      body: mcpBody(),
    });
    expect(response.status).toBe(401);

    expect(response.headers['www-authenticate']).not.toContain('error="invalid_token"');
  });

  it('defaults Keycloak audience enforcement to log-only', () => {
    const defaultConfig = {
      get: <T>(key: string, fallback?: T) =>
        (({
          JWT_SECRET: localSecret,
          BRIGADE_TRUSTED_ISSUERS: '',
          KEYCLOAK_URL: 'https://auth.example.test',
          KEYCLOAK_REALM: 'uchub',
          KEYCLOAK_CLIENT_ID: 'email-ops',
        })[key] ?? fallback) as T,
    } as unknown as ConfigService;
    const strategy = new JwtStrategy(defaultConfig, authService);
    expect((strategy as any).keycloakEnforceAudience).toBe(false);
  });

  it('uses forwarded public origin when the configured public URL is unset', () => {
    const service = new OAuthDiscoveryService({
      get: <T>(key: string) =>
        ({
          KEYCLOAK_URL: 'https://auth.example.test',
          KEYCLOAK_REALM: 'uchub',
        })[key] as T,
    } as unknown as ConfigService);
    const metadata = service.getMetadata({
      headers: {
        host: 'internal:3231',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'email-ops.example.test',
      },
      protocol: 'http',
      get: () => 'internal:3231',
    } as any);

    expect(metadata.resource).toBe('https://email-ops.example.test/api/v1/mcp');
  });
});
