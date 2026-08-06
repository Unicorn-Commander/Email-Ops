import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { MailProviderModule } from '../mail-provider/mail-provider.module';
import { MailEngineAdminModule } from '../mail-engine-admin/mail-engine-admin.module';
import { StalwartModule } from '../stalwart/stalwart.module';
import { MailContactsService } from './mail-contacts.service';
import { MailVacationService } from './mail-vacation.service';
import { MailSignaturesService } from './mail-signatures.service';
import { MailAutoconfigController } from './mail-autoconfig.controller';
import { MailboxAccountsController } from './mailbox-accounts.controller';
import { MailboxAccountsService } from './mailbox-accounts.service';
import { DeviceConfigService } from './device-config.service';

/**
 * Mailbox management (the net-new MailboxAccount CRUD). The controller gates
 * writes via the ProvisioningPolicyService; the service is the canonical apply
 * path the approval queue replays. Exported so the provisioning approval flow can
 * call it. PrismaService is global.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, ProvisioningModule, MailProviderModule, MailEngineAdminModule, StalwartModule],
  controllers: [MailboxAccountsController, MailAutoconfigController],
  providers: [MailboxAccountsService, MailSignaturesService, MailContactsService, DeviceConfigService, MailVacationService],
  exports: [MailboxAccountsService],
})
export class MailboxAccountsModule {}
