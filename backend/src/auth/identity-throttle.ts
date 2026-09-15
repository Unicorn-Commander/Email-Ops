import { createHash } from 'crypto';

/**
 * Rate-limit trackers for Email-Ops.
 *
 * Nest's default ThrottlerGuard keys on req.ip. Behind Traefik / oauth2-proxy
 * every cockpit session, MCP agent, and federation caller on this Mac collapses
 * into ONE bucket, so a parallel inbox sweep 429s compose_email (and vice versa).
 *
 * short/long: per credential (verified req.user when present, else SHA-256 of
 * the Bearer token, else IP). Agents on the same NAT no longer share a cap.
 *
 * ip: a high per-IP ceiling so rotating junk Bearers cannot unbounded-DoS.
 *
 * Named-throttler SkipThrottle maps MUST include `ip` as well as short/long
 * (v5: a missing name is still enforced). Use SKIP_ALL_THROTTLERS.
 */

export const SKIP_ALL_THROTTLERS = { short: true, long: true, ip: true } as const;

export function requestIp(req: Record<string, any>): string {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && typeof forwarded[0] === 'string') {
    return forwarded[0].split(',')[0].trim();
  }
  if (Array.isArray(req.ips) && typeof req.ips[0] === 'string' && req.ips[0]) {
    return req.ips[0];
  }
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

function bearerDigest(req: Record<string, any>): string | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (token.length < 8) return null;
  return createHash('sha256').update(token).digest('hex').slice(0, 24);
}

/** Tracker for the short/long named throttlers. */
export async function credentialTracker(req: Record<string, any>): Promise<string> {
  const uid = userId(req);
  if (uid) return `user:${uid}`;
  const digest = bearerDigest(req);
  if (digest) return `cred:${digest}`;
  return `ip:${requestIp(req)}`;
}

/** Tracker for the per-IP ceiling. */
export async function ipTracker(req: Record<string, any>): Promise<string> {
  return `ip:${requestIp(req)}`;
}
