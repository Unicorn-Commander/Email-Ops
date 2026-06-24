/**
 * Twilio inbound-SMS webhook receiver. POST /webhooks/twilio — Twilio posts an
 * inbound message (application/x-www-form-urlencoded: MessageSid/From/To/Body).
 * PROVIDER-authed (TwilioWebhookGuard, a shared secret), NOT under the user-JWT /
 * membership guards, rate-limit-exempt. NEVER open by default: the guard 503s
 * unless SMS_WEBHOOKS_ENABLED is on AND TWILIO_WEBHOOK_SECRET is set.
 *
 * Maps the inbound to SmsService.recordInboundSms (privileged toPhoneNumber→
 * workspace resolve + RLS-scoped idempotent persist), then ACKs with empty TwiML
 * (`<Response/>`) so Twilio sends no auto-reply and stops retrying. An
 * authenticated-but-malformed body still ACKs 200 (discard) — only a forged/
 * disabled call (the guard) is a non-2xx.
 */

import { Body, Controller, Header, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { SmsService } from './sms.service';
import { TwilioWebhookGuard } from './twilio-webhook.guard';

interface TwilioInboundBody {
  MessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

@ApiExcludeController()
@SkipThrottle({ short: true, long: true })
@Controller('webhooks')
export class TwilioWebhookController {
  private readonly logger = new Logger(TwilioWebhookController.name);

  constructor(private readonly sms: SmsService) {}

  @Post('twilio')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  @UseGuards(TwilioWebhookGuard)
  async inbound(@Body() body: TwilioInboundBody): Promise<string> {
    const sid = typeof body?.MessageSid === 'string' ? body.MessageSid.trim() : '';
    const from = typeof body?.From === 'string' ? body.From.trim() : '';
    const to = typeof body?.To === 'string' ? body.To.trim() : '';
    const text = typeof body?.Body === 'string' ? body.Body : '';

    if (!sid || !from || !to) {
      this.logger.warn('inbound twilio webhook missing MessageSid/From/To — ACKing + discarding.');
      return EMPTY_TWIML;
    }

    const result = await this.sms.recordInboundSms({
      provider: 'twilio',
      providerMessageId: sid,
      fromPhoneNumber: from,
      toPhoneNumber: to,
      body: text,
    });
    this.logger.log(`inbound twilio ${sid} → ${result.outcome} (workspace=${result.workspaceId ?? 'none'})`);
    return EMPTY_TWIML;
  }
}
