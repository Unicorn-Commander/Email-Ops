import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectedAccountsModule } from '../connected-accounts/connected-accounts.module';
import { MailProviderPort } from './mail-provider.port';
import { EngineMailProvider } from './engine-mail-provider';

/**
 * The unified-inbox external-provider seam. Binds MailProviderPort to the
 * engine-backed impl (Gmail / Microsoft 365 via the cleaner-engine /mail/* routes
 * + the Keycloak broker token). Exported so EmailService dispatches external
 * mailboxes here while the sovereign ('stalwart') path stays on StalwartPort.
 * AuthModule provides the broker; ConnectedAccountsModule the engine port.
 */
@Module({
  imports: [AuthModule, ConnectedAccountsModule],
  providers: [{ provide: MailProviderPort, useClass: EngineMailProvider }],
  exports: [MailProviderPort],
})
export class MailProviderModule {}
