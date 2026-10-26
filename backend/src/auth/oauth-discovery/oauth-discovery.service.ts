import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

export const MCP_PATH = '/api/v1/mcp';
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const RESOURCE_DOCUMENTATION_URL = 'https://unicorncommander.ai/platform/bring-your-own-ai';

export const EMAIL_OPS_MCP_SCOPES = [
  'mail:read',
  'mail:write',
  'agent-inbox:read',
  'agent-inbox:approve',
  'cleaner:run',
  'admin:provision',
  'ui:control',
] as const;

export interface ConfigReader {
  get<T = any>(propertyPath: string, defaultValue?: T): T;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
  resource_name: string;
  resource_documentation: string;
}

/**
 * RFC 9728 metadata for the Email-Ops MCP resource.
 *
 * The public origin is configured with the existing EMAIL_OPS_PUBLIC_BASE_URL
 * setting. For self-hosted/local instances, the trusted forwarded request
 * origin is used instead. The MCP path is appended here so metadata cannot
 * drift from the route clients connect to.
 */
@Injectable()
export class OAuthDiscoveryService {
  constructor(private readonly config: ConfigService) {}

  getMetadata(request: Request): ProtectedResourceMetadata {
    const publicOrigin = resolvePublicOrigin(request, this.config);
    return {
      resource: `${publicOrigin}${MCP_PATH}`,
      authorization_servers: [this.getAuthorizationServer()],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'profile', ...EMAIL_OPS_MCP_SCOPES],
      resource_name: 'Email-Ops MCP',
      resource_documentation: RESOURCE_DOCUMENTATION_URL,
    };
  }

  /** The issuer is always derived from the ring's configured Keycloak base URL. */
  getAuthorizationServer(): string {
    const configuredBase = (this.config.get<string>('KEYCLOAK_URL') || '').trim();
    const base = parseIssuerBase(configuredBase);
    if (!base) {
      throw new Error('KEYCLOAK_URL must be configured for MCP OAuth discovery');
    }
    const realm = (this.config.get<string>('KEYCLOAK_REALM', 'uchub') || 'uchub').trim();
    if (!realm) {
      throw new Error('KEYCLOAK_REALM must be configured for MCP OAuth discovery');
    }
    return `${base}/realms/${encodeURIComponent(realm)}`;
  }
}

/**
 * Resolve only an origin. Rejecting userinfo, query strings, and fragments
 * keeps request-derived metadata from becoming a credential-bearing URL.
 */
export function resolvePublicOrigin(request: Request, config?: ConfigReader): string {
  const configured =
    config?.get<string>('EMAIL_OPS_PUBLIC_BASE_URL') ||
    config?.get<string>('PUBLIC_BASE_URL') ||
    config?.get<string>('PUBLIC_API_BASE_URL');
  if (configured?.trim()) {
    const origin = parseOrigin(configured.trim());
    if (origin) return origin;
  }

  const forwardedProto = firstHeader(request.headers['x-forwarded-proto']);
  const protocol = normalizeProtocol(forwardedProto || request.protocol || 'http');
  const forwardedHost = firstHeader(request.headers['x-forwarded-host']);
  const requestHost = typeof request.get === 'function' ? request.get('host') : undefined;
  const host = forwardedHost || firstHeader(request.headers.host) || requestHost;
  const origin = parseOrigin(`${protocol}://${host || 'localhost'}`);
  return origin || `${protocol}://localhost`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.split(',')[0]?.trim() || undefined;
  if (typeof value === 'string') return value.split(',')[0]?.trim() || undefined;
  return undefined;
}

function normalizeProtocol(value: string): 'http' | 'https' {
  return value.trim().toLowerCase() === 'https' ? 'https' : 'http';
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseIssuerBase(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}
