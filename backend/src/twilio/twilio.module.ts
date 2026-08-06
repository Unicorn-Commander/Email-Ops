import { Module } from '@nestjs/common';
import { TwilioPort } from './twilio.port';
import { TwilioClient } from './twilio.client';

/**
 * The SMS engine seam. Binds the TwilioPort DI token to the concrete TwilioClient
 * (federate-the-engine, like StalwartModule). The SMS send path injects
 * `TwilioPort` and gets a degrade-clean client — a unit test substitutes a fake
 * TwilioPort with no live provider.
 */
@Module({
  providers: [{ provide: TwilioPort, useClass: TwilioClient }],
  exports: [TwilioPort],
})
export class TwilioModule {}
