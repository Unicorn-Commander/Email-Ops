import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StalwartPort } from './stalwart.port';
import { StalwartClient } from './stalwart.client';
import { JamesClient } from './james.client';

/**
 * Select the sovereign mail data plane without making the mailbox row carry
 * the transport implementation name. Existing rows use provider=stalwart for
 * the sovereign lane, while the current sovereign engine is James.
 */
export function selectMailEngine(
  configured: string | undefined,
  stalwart: StalwartPort,
  james: StalwartPort,
): StalwartPort {
  const engine = configured?.trim().toLowerCase();
  if (engine === 'james') return james;
  if (engine === 'stalwart') return stalwart;
  return james.isConfigured() ? james : stalwart;
}

/**
 * The mail-engine seam. Binds the StalwartPort DI token to the concrete engine
 * client selected by `MAIL_ENGINE` (federate-the-engine; Email-Ops is
 * provider-agnostic):
 *   - MAIL_ENGINE=james     → JamesClient   (Apache James, JMAP — the migration target)
 *   - MAIL_ENGINE=stalwart  → StalwartClient (explicit legacy-engine override)
 *   - unset                  → JamesClient when James is configured, otherwise StalwartClient
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
        return selectMailEngine(config.get<string>('MAIL_ENGINE'), stalwart, james);
      },
    },
  ],
  exports: [StalwartPort],
})
export class StalwartModule {}
