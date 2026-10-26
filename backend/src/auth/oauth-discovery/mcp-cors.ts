import { ConfigReader, MCP_PATH, PROTECTED_RESOURCE_PATH } from './oauth-discovery.service';
import { isMcpRequest } from './mcp-auth-header';

const MCP_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'Mcp-Session-Id',
  'Mcp-Protocol-Version',
  'Last-Event-ID',
].join(', ');

const MCP_EXPOSED_HEADERS = 'Mcp-Session-Id';

/**
 * CORS middleware mounted before Nest guards. MCP never uses cookie/session
 * authentication; browser clients send the bearer in the allowed header.
 */
export function createMcpCorsMiddleware(config: ConfigReader) {
  const allowedOrigins = readAllowedOrigins(config);

  return (request: any, response: any, next: () => void): void => {
    if (isProtectedResourceRequest(request)) {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.removeHeader('Access-Control-Allow-Credentials');
      response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
      response.setHeader('Cache-Control', 'public, max-age=3600');
      if (String(request.method || '').toUpperCase() === 'OPTIONS') {
        response.status(204).send();
        return;
      }
      // The general CORS middleware runs after this one. Hide Origin for the
      // public metadata GET so it cannot replace RFC 9728's `*` with the UI
      // origin or add credentialed CORS headers.
      if (request.headers) delete request.headers.origin;
      next();
      return;
    }

    if (!isMcpRequest(request)) {
      next();
      return;
    }

    const rawOrigin = request.headers?.origin;
    const origin = normalizeOrigin(rawOrigin);
    if (rawOrigin && (!origin || !allowedOrigins.has(origin))) {
      response.status(403).json({ error: 'origin_not_allowed' });
      return;
    }

    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    response.removeHeader('Access-Control-Allow-Credentials');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', MCP_ALLOWED_HEADERS);
    response.setHeader('Access-Control-Expose-Headers', MCP_EXPOSED_HEADERS);

    if (String(request.method || '').toUpperCase() === 'OPTIONS') {
      response.status(204).send();
      return;
    }

    next();
  };
}

function isProtectedResourceRequest(request: any): boolean {
  const path =
    (typeof request.path === 'string' && request.path) ||
    request.originalUrl?.split('?', 1)[0] ||
    request.url?.split('?', 1)[0] ||
    '';
  return (
    path === PROTECTED_RESOURCE_PATH ||
    path === `${PROTECTED_RESOURCE_PATH}${MCP_PATH}` ||
    path === `${PROTECTED_RESOURCE_PATH}/` ||
    path === `${PROTECTED_RESOURCE_PATH}${MCP_PATH}/`
  );
}

export function readAllowedOrigins(config: ConfigReader): Set<string> {
  const values = [
    config.get<string>('CORS_ORIGIN', 'http://localhost:3001'),
    config.get<string>('FRONTEND_URL'),
    config.get<string>('EMAIL_OPS_PUBLIC_BASE_URL'),
    config.get<string>('PUBLIC_BASE_URL'),
    config.get<string>('PUBLIC_API_BASE_URL'),
    config.get<string>('MCP_CORS_ORIGINS'),
  ];
  const origins = new Set<string>();
  for (const value of values) {
    for (const candidate of (value || '').split(',')) {
      const normalized = normalizeOrigin(candidate);
      if (normalized && normalized !== '*') origins.add(normalized);
    }
  }
  return origins;
}

function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
