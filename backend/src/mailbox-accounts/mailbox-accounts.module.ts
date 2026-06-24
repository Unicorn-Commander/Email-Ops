import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { MailProviderModule } from '../mail-provider/mail-provider.module';
import { MailboxAccountsController } from './mailbox-accounts.controller';
import { MailboxAccountsService } from './mailbox-accounts.service';

/**
 * Mailbox management (the net-new MailboxAccount CRUD). The controller gates
 * writes via the ProvisioningPolicyService; the service is the canonical apply
 * path the approval queue replays. Exported so the provisioning approval flow can
 * call it. PrismaService is global.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, ProvisioningModule, MailProviderModule],
  controllers: [MailboxAccountsController],
  providers: [MailboxAccountsService],
  exports: [MailboxAccountsService],
})
export class MailboxAccountsModule {}
