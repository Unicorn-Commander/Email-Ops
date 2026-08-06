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

/**
 * Provider-auth guard for the Twilio inbound-SMS webhook. Mirrors the
 * PostmarkWebhookGuard posture: PROVIDER-authed (a machine caller with no uchub
 * identity), a configurable shared secret, fail-closed.
 *
 * Twilio supports embedding HTTP Basic credentials in the webhook URL
 * (https://user:secret@host/webhooks/twilio), so we accept the Basic password
 * component OR an `X-Twilio-Webhook-Token` / `Authorization: Bearer` header — the
 * secret is `TWILIO_WEBHOOK_SECRET`. (Twilio's native X-Twilio-Signature HMAC is a
 * possible future enhancement; a shared secret over HTTPS is equally sound and
 * matches the suite's existing webhook posture.)
 *
 * DEGRADE-CLEAN — never open by default:
 *   - SMS_WEBHOOKS_ENABLED not truthy (default) → 503 (receiver off).
 *   - TWILIO_WEBHOOK_SECRET unset → 503 (no credential to verify; refuse forgeable calls).
 *   - secret set + enabled + presented mismatch/absent → 401.
 * The comparison is constant-time.
 */
@Injectable()
export class TwilioWebhookGuard implements CanActivate {
  private readonly logger = new Logger(TwilioWebhookGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    if (!this.enabled()) {
      this.logger.warn('Twilio webhook hit while SMS_WEBHOOKS_ENABLED is off — 503 (receiver disabled).');
      throw new ServiceUnavailableException('Email-Ops SMS webhook receiver is disabled.');
    }

    const secret = (this.config.get<string>('TWILIO_WEBHOOK_SECRET') ?? '').trim();
    if (!secret) {
      this.logger.warn(
        'Twilio webhook hit but TWILIO_WEBHOOK_SECRET is unset — 503 (no credential to verify; refusing forgeable calls).',
      );
      throw new ServiceUnavailableException('Email-Ops SMS webhook receiver is not configured.');
    }

    const presented = this.extractPresentedSecret(req);
    if (!presented || !TwilioWebhookGuard.secretsMatch(presented, secret)) {
      this.logger.warn(`Rejected Twilio webhook: ${presented ? 'secret mismatch' : 'no credential presented'} (401).`);
      throw new UnauthorizedException('Invalid webhook credential.');
    }
    return true;
  }

  private enabled(): boolean {
    const raw = (this.config.get<string>('SMS_WEBHOOKS_ENABLED') ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  }

  private extractPresentedSecret(req: Request): string | null {
    const auth = (req.headers['authorization'] as string | undefined) ?? '';
    if (auth.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        return idx >= 0 ? decoded.slice(idx + 1) : decoded;
      } catch {
        return null;
      }
    }
    if (auth.startsWith('Bearer ')) {
      return auth.slice(7).trim() || null;
    }
    const headerToken = req.headers['x-twilio-webhook-token'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
      return headerToken.trim();
    }
    return null;
  }

  /** Constant-time secret comparison (length-guarded so timingSafeEqual is safe). */
  static secretsMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
