import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ProvisioningPolicyController } from './provisioning-policy.controller';
import { ProvisioningPolicyService } from './provisioning-policy.service';

/**
 * The provisioning RBAC surface: the per-workspace policy + the gate other write
 * surfaces (agents, mailboxes) call to authorize a provisioning action. Exports
 * ProvisioningPolicyService so AgentsModule / MailboxAccountsModule can gate.
 * PrismaService is global.
 */
@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [ProvisioningPolicyController],
  providers: [ProvisioningPolicyService],
  exports: [ProvisioningPolicyService],
})
export class ProvisioningModule {}
