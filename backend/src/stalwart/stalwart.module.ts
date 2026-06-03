import { Module } from '@nestjs/common';
import { StalwartPort } from './stalwart.port';
import { StalwartClient } from './stalwart.client';

/**
 * The Stalwart mail-engine seam. Binds the StalwartPort DI token to the concrete
 * StalwartClient (federate-the-engine). Anything that needs mailbox reads or an
 * outbound send injects `StalwartPort` and gets a degrade-clean client — a
 * unit test substitutes a fake StalwartPort with no live mail server.
 */
@Module({
  providers: [{ provide: StalwartPort, useClass: StalwartClient }],
  exports: [StalwartPort],
})
export class StalwartModule {}
