import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { createHash } from 'crypto';
import { isMcpRequest } from './oauth-discovery/mcp-auth-header';

export type ThrottlePrincipalKind = 'session' | 'pat' | 'mcp' | 'anonymous';

export interface ThrottleProfile {
  short: number;
  long: number;
}

export const DEFAULT_THROTTLE_PROFILE: Readonly<ThrottleProfile> = {
  short: 20,
  long: 200,
};

export const DEFAULT_SESSION_THROTTLE_PROFILE: Readonly<ThrottleProfile> = {
  short: 300,
  long: 5000,
};

export const DEFAULT_THROTTLE_IP_PER_MIN = 200;

/**
 * Rate-limit trackers for Email-Ops.
 *
 * Nest's default ThrottlerGuard keys on req.ip. Behind Traefik / oauth2-proxy
 * every cockpit session, MCP agent, and federation caller on this Mac collapses
 * into ONE bucket, so a parallel inbox sweep 429s compose_email (and vice versa).
 *
 * short/long: per credential (verified req.user when present, else SHA-256 of
 * the Bearer token or session cookie, else IP). Agents on the same NAT no
 * longer share a cap, and browser sessions do not share one cookie bucket.
 *
 * ip: a high per-IP ceiling so rotating junk Bearers cannot unbounded-DoS.
 *
 * Named-throttler SkipThrottle maps MUST include `ip` as well as short/long
 * (v5: a missing name is still enforced). Use SKIP_ALL_THROTTLERS.
 */

export const SKIP_ALL_THROTTLERS = { short: true, long: true, ip: true } as const;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// req.ip only: main.ts sets `trust proxy` 1, so Express already resolves the
// hop Traefik saw. The leftmost X-Forwarded-For (and req.ips[0]) is
// client-supplied — reading it lets rotating fake XFF values bypass `ip`.
export function requestIp(req: Record<string, any>): string {
  if (typeof req.ip === 'string' && req.ip) {
    return req.ip;
  }
  return 'unknown';
}

function userId(req: Record<string, any>): string | null {
  const user = req.user;
  if (!user || typeof user !== 'object') return null;
  if (typeof user.id === 'string' && user.id.length > 0) return user.id;
  if (typeof user.keycloakId === 'string' && user.keycloakId.length > 0) return user.keycloakId;
  return null;
}

function authorizationToken(req: Record<string, any>): string | null {
  const header = req.headers?.authorization ?? req.headers?.Authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

function sessionCookieToken(req: Record<string, any>): string | null {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1 || part.slice(0, idx).trim() !== 'access_token') continue;
    const value = part.slice(idx + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function digest(value: string | null): string | null {
  if (!value || value.length < 8) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function bearerDigest(req: Record<string, any>): string | null {
  return digest(authorizationToken(req));
}

function sessionDigest(req: Record<string, any>): string | null {
  return digest(sessionCookieToken(req));
}

function hasPatCredential(req: Record<string, any>): boolean {
  if (req.user?.__patAuth) return true;
  return authorizationToken(req)?.startsWith('eo_pat_') ?? false;
}

function isJwtBearer(token: string | null): boolean {
  if (!token) return false;
  const segments = token.split('.');
  return segments.length === 3 && segments.every(Boolean);
}

/** Identify the auth transport before downstream auth guards populate req.user. */
export function throttlePrincipalKind(req: Record<string, any>): ThrottlePrincipalKind {
  if (hasPatCredential(req)) return 'pat';

  const bearer = authorizationToken(req);
  if (isMcpRequest(req as any)) return bearer ? 'mcp' : 'anonymous';

  if (isJwtBearer(sessionCookieToken(req)) || isJwtBearer(bearer) || userId(req)) {
    return 'session';
  }
  return 'anonymous';
}

/** Resolve the short/long profile for the request's principal kind. */
export function throttleProfile(req: Record<string, any>): ThrottleProfile {
  if (throttlePrincipalKind(req) === 'session') {
    return {
      short: positiveEnvInt('THROTTLE_SESSION_SHORT', DEFAULT_SESSION_THROTTLE_PROFILE.short),
      long: positiveEnvInt('THROTTLE_SESSION_LONG', DEFAULT_SESSION_THROTTLE_PROFILE.long),
    };
  }

  return {
    short: positiveEnvInt('THROTTLE_CREDENTIAL_SHORT', DEFAULT_THROTTLE_PROFILE.short),
    long: positiveEnvInt('THROTTLE_CREDENTIAL_LONG', DEFAULT_THROTTLE_PROFILE.long),
  };
}

export function throttleIpLimit(): number {
  return positiveEnvInt('THROTTLE_IP_PER_MIN', DEFAULT_THROTTLE_IP_PER_MIN);
}

/** Tracker for the short/long named throttlers. */
export async function credentialTracker(req: Record<string, any>): Promise<string> {
  const uid = userId(req);
  if (uid) return `user:${uid}`;
  const digest = bearerDigest(req);
  if (digest) return `cred:${digest}`;
  const session = sessionDigest(req);
  if (session) return `session:${session}`;
  return `ip:${requestIp(req)}`;
}

/** Tracker for the per-IP ceiling. */
export async function ipTracker(req: Record<string, any>): Promise<string> {
  return `ip:${requestIp(req)}`;
}

/**
 * Global guard that keeps route-level @Throttle metadata from widening the
 * credential profiles. Session routes may retain a lower, action-specific cap;
 * PAT/MCP/anonymous callers can never inherit a higher route override.
 */
@Injectable()
export class ProfiledThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, limit, throttler } = requestProps;
    const { req } = this.getRequestResponse(context);
    const profile = throttleProfile(req);
    const profileLimit =
      throttler.name === 'short'
        ? profile.short
        : throttler.name === 'long'
          ? profile.long
          : undefined;
    const effectiveLimit =
      profileLimit === undefined && throttler.name !== 'ip'
        ? limit
        : Math.min(profileLimit ?? throttleIpLimit(), limit);
    return super.handleRequest({ ...requestProps, limit: effectiveLimit });
  }
}
