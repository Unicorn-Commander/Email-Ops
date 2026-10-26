import { Request, Response } from 'express';
import {
  ConfigReader,
  MCP_PATH,
  PROTECTED_RESOURCE_PATH,
  resolvePublicOrigin,
} from './oauth-discovery.service';

export const MCP_REALM = 'email-ops-mcp';

/** True when the request carries a non-empty Bearer credential. */
export function hasBearerToken(request: Request): boolean {
  const value = request.headers?.authorization ?? (request.headers as any)?.Authorization;
  if (typeof value !== 'string') return false;
  const [scheme, token] = value.split(/\s+/, 2);
  return scheme?.toLowerCase() === 'bearer' && Boolean(token?.trim());
}

export function isMcpRequest(request: Request): boolean {
  const path =
    (typeof request.path === 'string' && request.path) ||
    request.originalUrl?.split('?', 1)[0] ||
    request.url?.split('?', 1)[0] ||
    '';
  return path === MCP_PATH || path === `${MCP_PATH}/`;
}

/**
 * Add the RFC 9728 challenge only to the MCP resource-server path. The body
 * remains Nest's generic 401 JSON; no presented credential is copied anywhere.
 */
export function setMcpUnauthorizedHeader(
  request: Request,
  response: Response,
  config?: ConfigReader,
  tokenPresented = hasBearerToken(request),
): void {
  if (!isMcpRequest(request)) return;

  const metadataUrl = `${resolvePublicOrigin(request, config)}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;
  const error = tokenPresented ? ', error="invalid_token"' : '';
  response.setHeader(
    'WWW-Authenticate',
    `Bearer realm="${MCP_REALM}", resource_metadata="${metadataUrl}"${error}`,
  );
}
