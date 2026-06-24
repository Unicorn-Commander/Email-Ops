import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwilioPort } from './twilio.port';
import { TwilioSendRequest, TwilioSendResult } from './twilio.types';

/**
 * The concrete SMS engine: Twilio's REST API over fetch (no SDK dependency —
 * minimal footprint, mirrors the rest of the suite's HTTP seams).
 *
 * DEGRADE-CLEAN: with TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN unset, isConfigured()
 * is false and send() returns `{accepted:false, reason:'not-configured'}` WITHOUT
 * any network call — the SMS channel is dormant until configured, and the email
 * path is entirely unaffected. send() never throws (best-effort, like Stalwart).
 *
 * Twilio is the not-self-hostable provider for the enterprise/shared-line scope;
 * an in-house SMS engine later implements the same TwilioPort and the send path
 * is unchanged.
 */
@Injectable()
export class TwilioClient extends TwilioPort {
  private readonly logger = new Logger(TwilioClient.name);

  constructor(private readonly config: ConfigService) {
    super();
    if (!this.isConfigured()) {
      this.logger.warn(
        'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN unset — the SMS engine is DORMANT; ' +
          'sends are not accepted (degrade-clean) and no SMS network call is made until configured.',
      );
    } else {
      this.logger.log(`SMS engine configured (Twilio account ${this.accountSid?.slice(0, 6)}…).`);
    }
  }

  private get accountSid(): string | null {
    const v = this.config.get<string>('TWILIO_ACCOUNT_SID');
    return v && v.trim() ? v.trim() : null;
  }

  private get authToken(): string | null {
    const v = this.config.get<string>('TWILIO_AUTH_TOKEN');
    return v && v.trim() ? v.trim() : null;
  }

  /** Override for tests / regional endpoints. Defaults to Twilio's public API. */
  private get baseUrl(): string {
    const v = this.config.get<string>('TWILIO_API_BASE_URL');
    return (v && v.trim() ? v.trim() : 'https://api.twilio.com').replace(/\/$/, '');
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('TWILIO_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  isConfigured(): boolean {
    return !!(this.accountSid && this.authToken);
  }

  async send(request: TwilioSendRequest): Promise<TwilioSendResult> {
    if (!this.isConfigured()) {
      return { accepted: false, providerMessageId: null, lane: null, reason: 'not-configured' };
    }
    if (!request.fromPhoneNumber || !request.toPhoneNumber || !request.body) {
      return { accepted: false, providerMessageId: null, lane: 'twilio', reason: 'invalid request' };
    }

    const url = `${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const form = new URLSearchParams({
      From: request.fromPhoneNumber,
      To: request.toPhoneNumber,
      Body: request.body,
    });
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${auth}`,
        },
        body: form.toString(),
      });
    } catch (err) {
      this.logger.warn(`Twilio send transport error: ${(err as Error).message}`);
      return { accepted: false, providerMessageId: null, lane: 'twilio', reason: (err as Error).message };
    }

    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`Twilio send HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { accepted: false, providerMessageId: null, lane: 'twilio', reason: `http ${res.status}` };
    }
    let sid: string | null = null;
    try {
      sid = (JSON.parse(text) as { sid?: string }).sid ?? null;
    } catch {
      sid = null;
    }
    return { accepted: true, providerMessageId: sid, lane: 'twilio' };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
