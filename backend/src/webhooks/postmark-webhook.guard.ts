import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { webhooksEnabled } from '../common/workspace/feature-flags';

/**
 * Provider-auth guard for the Postmark inbound webhook (Phase 2, Part A).
 *
 * This route is PROVIDER-authed, NOT under the user-JWT / workspace-membership
 * guards — Postmark is a machine caller with no uchub identity. Authentication
 * is a configurable shared secret (`POSTMARK_WEBHOOK_SECRET`). Postmark supports
 * either embedding HTTP Basic credentials in the webhook URL
 * (https://user:secret@host/webhooks/postmark) OR a custom header; we accept
 * BOTH, matching whatever the operator configured:
 *   1. HTTP Basic — `Authorization: Basic base64(user:secret)`; the PASSWORD
 *      component must equal the secret (the username is ignored).
 *   2. A bearer/token header — `X-Postmark-Webhook-Token: <secret>` (or
 *      `Authorization: Bearer <secret>`).
 *
 * DEGRADE-CLEAN (binding, brief): the route is NEVER open by default.
 *   - `EMAIL_WEBHOOKS_ENABLED` false (default) → 503. The receiver is off.
 *   - secret unset/empty → 503. There is no credential to verify against, so we
 *     refuse rather than accept anything. (Fail-closed: an un-configured webhook
 *     must not silently accept forged engagement.)
 *   - secret set + flag on + presented credential mismatches/absent → 401.
 *
 * The comparison is constant-time (`timingSafeEqual`) so a forged caller can't
 * probe the secret by timing.
 */
@Injectable()
export class PostmarkWebhookGuard implements CanActivate {
  private readonly logger = new Logger(PostmarkWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // 503 unless deliberately enabled — the route is inert by default.
    if (!webhooksEnabled((k) => this.config.get<string>(k))) {
      this.logger.warn(
        'Postmark webhook hit while EMAIL_WEBHOOKS_ENABLED is off — returning 503 (receiver disabled).',
      );
      throw new ServiceUnavailableException('Email-Ops webhook receiver is disabled.');
    }

    const secret = (this.config.get<string>('POSTMARK_WEBHOOK_SECRET') ?? '').trim();
    if (!secret) {
      // Fail-closed: no credential configured → refuse, never accept.
      this.logger.warn(
        'Postmark webhook hit but POSTMARK_WEBHOOK_SECRET is unset — returning 503 (no credential to verify; refusing to accept forgeable calls).',
      );
      throw new ServiceUnavailableException('Email-Ops webhook receiver is not configured.');
    }

    const presented = this.extractPresentedSecret(req);
    if (!presented || !PostmarkWebhookGuard.secretsMatch(presented, secret)) {
      this.logger.warn(
        `Rejected Postmark webhook: ${presented ? 'secret mismatch' : 'no credential presented'} (401).`,
      );
      throw new UnauthorizedException('Invalid webhook credential.');
    }
    return true;
  }

  /**
   * Pull the presented secret from the request, supporting both Basic auth (the
   * password component) and a token header. Returns null when none is present.
   */
  private extractPresentedSecret(req: Request): string | null {
    const auth = (req.headers['authorization'] as string | undefined) ?? '';

    if (auth.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
        // user:password — the password (everything after the FIRST colon) is the
        // secret. A colon-less value is treated as the whole secret.
        const idx = decoded.indexOf(':');
        return idx >= 0 ? decoded.slice(idx + 1) : decoded;
      } catch {
        return null;
      }
    }
    if (auth.startsWith('Bearer ')) {
      return auth.slice(7).trim() || null;
    }
    const headerToken = req.headers['x-postmark-webhook-token'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
      return headerToken.trim();
    }
    return null;
  }

  /**
   * Constant-time secret comparison. Length differences are handled without
   * early-out by comparing fixed-size SHA-equivalent buffers via a length guard
   * plus timingSafeEqual on equal-length inputs (timingSafeEqual throws on length
   * mismatch, so we guard length first — the length itself is not secret).
   */
  static secretsMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
