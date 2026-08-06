import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { StalwartModule } from '../stalwart/stalwart.module';
import { ConnectedAccountsModule } from '../connected-accounts/connected-accounts.module';
import { MailProviderModule } from '../mail-provider/mail-provider.module';
import { NotifyModule } from '../notify/notify.module';

/**
 * The Email-Ops core domain: the SoR + the EmailOpsPort contract logic + the
 * agent-inbox approval flow (EmailService), wired to the degrade-clean
 * StalwartPort. Exported so the MCP server (and a future REST surface) delegate
 * to the SAME implementation — one set of rules, one RLS path.
 */
@Module({
  imports: [StalwartModule, ConnectedAccountsModule, MailProviderModule, NotifyModule],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
