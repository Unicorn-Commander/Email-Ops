import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { CalendarCredential, CalendarCredentialMailbox } from './calendar.types';
import { CalendarBridgeClient } from './calendar-bridge.client';
import { CalendarCredentialsPort } from './calendar-credentials.port';

const BACKEND_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedBackendKey {
  workspaceId: string;
  appId: string;
  username: string;
  password: string;
  expiresAt: number;
}

/**
 * Production calendar credential resolver. Davis is the authority: Email-Ops
 * keeps only the live credential in process memory and never persists a secret
 * or verifier in Prisma.
 */
@Injectable()
export class BridgeCalendarCredentials extends CalendarCredentialsPort implements OnModuleDestroy {
  private readonly cache = new Map<string, CachedBackendKey>();

  constructor(private readonly bridge: CalendarBridgeClient) {
    super();
  }

  async resolve(
    workspaceId: string,
    mailbox: CalendarCredentialMailbox,
  ): Promise<CalendarCredential | null> {
    const login = mailbox.emailAddress.trim().toLowerCase();
    const cacheKey = `${workspaceId}\u0000${login}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) {
      return { username: cached.username, password: cached.password };
    }
    if (cached) this.cache.delete(cacheKey);

    try {
      const created = await this.bridge.createKey(
        {
          login,
          label: 'email-ops-backend',
          purpose: 'backend',
          ttl_seconds: BACKEND_TTL_SECONDS,
        },
        `calendar-backend-${shortDigest(`${workspaceId}:${login}`)}`,
      );
      const expiresAt = Date.parse(created.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= now + REFRESH_MARGIN_MS) {
        try {
          await this.bridge.revokeKey(created.app_id);
        } catch {
          // Davis expiry remains the backstop for an unusable short-lived key.
        }
        return null;
      }
      this.cache.set(cacheKey, {
        workspaceId,
        appId: created.app_id,
        username: created.username,
        password: created.secret,
        expiresAt,
      });
      return { username: created.username, password: created.secret };
    } catch {
      // CalendarService turns null into its existing fail-closed 503. The
      // bridge client's exception deliberately contains no response body.
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const cached = [...this.cache.values()];
    this.cache.clear();
    await Promise.all(
      cached.map(async (key) => {
        try {
          await this.bridge.revokeKey(key.appId);
        } catch {
          // Davis expiry remains the backstop when shutdown revocation cannot
          // reach the private bridge.
        }
      }),
    );
  }
}

function shortDigest(value: string): string {
  // Node's built-in crypto is not needed for the credential itself; this
  // deterministic idempotency suffix only prevents workspace/login collisions.
  let hash = 2166136261;
  for (const byte of Buffer.from(value, 'utf8')) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
