import { Module } from '@nestjs/common';
import { SmsService } from './sms.service';
import { TwilioModule } from '../twilio/twilio.module';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { TwilioWebhookGuard } from './twilio-webhook.guard';

/**
 * The SMS channel (enterprise/shared-line scope). SmsService is the SoR + send
 * path, reusing the email governance (autonomy dial, kill switch, agent-inbox,
 * audit) and wired to the degrade-clean TwilioPort. The inbound Twilio webhook
 * (provider-authed, fail-closed) delegates to the SAME SmsService. Exported so a
 * future REST / MCP surface delegates to the one implementation — one rule set,
 * one RLS path — exactly like EmailModule.
 */
@Module({
  imports: [TwilioModule],
  controllers: [TwilioWebhookController],
  providers: [SmsService, TwilioWebhookGuard],
  exports: [SmsService],
})
export class SmsModule {}
