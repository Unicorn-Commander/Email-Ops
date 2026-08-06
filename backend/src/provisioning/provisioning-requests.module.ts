import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AgentsModule } from '../agents/agents.module';
import { MailboxAccountsModule } from '../mailbox-accounts/mailbox-accounts.module';
import { ProvisioningModule } from './provisioning.module';
import { ProvisioningRequestsController } from './provisioning-requests.controller';
import { ProvisioningRequestsService } from './provisioning-requests.service';

/**
 * The approval queue. Imports the canonical apply services (Agents, Mailboxes) to
 * REPLAY an approved request, plus ProvisioningModule for the policy (approver
 * gate). One-way: those modules do NOT import this one (they file via
 * ProvisioningPolicyService.fileRequest), so the module graph stays acyclic.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, ProvisioningModule, MailboxAccountsModule, AgentsModule],
  controllers: [ProvisioningRequestsController],
  providers: [ProvisioningRequestsService],
})
export class ProvisioningRequestsModule {}
