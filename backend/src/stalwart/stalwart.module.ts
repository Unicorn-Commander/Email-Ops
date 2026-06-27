import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StalwartPort } from './stalwart.port';
import { StalwartClient } from './stalwart.client';
import { JamesClient } from './james.client';

/**
 * The mail-engine seam. Binds the StalwartPort DI token to the concrete engine
 * client selected by `MAIL_ENGINE` (federate-the-engine; Email-Ops is
 * provider-agnostic):
 *   - MAIL_ENGINE=james     → JamesClient   (Apache James, JMAP — the migration target)
 *   - MAIL_ENGINE=stalwart  → StalwartClient (default; the legacy engine, still supported)
 *
 * Both are degrade-clean: anything that needs mailbox reads or an outbound send
 * injects `StalwartPort` and gets a client that no-ops when its engine is unset.
 * Flipping the engine at cutover is a single env change — no service-layer churn.
 * A unit test substitutes a fake StalwartPort with no live mail server.
 */
@Module({
  providers: [
    StalwartClient,
    JamesClient,
    {
      provide: StalwartPort,
      inject: [ConfigService, StalwartClient, JamesClient],
      useFactory: (config: ConfigService, stalwart: StalwartClient, james: JamesClient) => {
        const engine = (config.get<string>('MAIL_ENGINE') ?? 'stalwart').trim().toLowerCase();
        return engine === 'james' ? james : stalwart;
      },
    },
  ],
  exports: [StalwartPort],
})
export class StalwartModule {}
