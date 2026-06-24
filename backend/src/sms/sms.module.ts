import { Module } from '@nestjs/common';
import { SmsService } from './sms.service';
import { TwilioModule } from '../twilio/twilio.module';

/**
 * The SMS channel (enterprise/shared-line scope). SmsService is the SoR + send
 * path, reusing the email governance (autonomy dial, kill switch, agent-inbox,
 * audit) and wired to the degrade-clean TwilioPort. Exported so a future REST /
 * MCP / webhook surface delegates to the SAME implementation — one rule set, one
 * RLS path — exactly like EmailModule.
 */
@Module({
  imports: [TwilioModule],
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
