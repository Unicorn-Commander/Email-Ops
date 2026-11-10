import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ProvisioningPolicyController } from './provisioning-policy.controller';
import { ProvisioningPolicyService } from './provisioning-policy.service';
import { WorkspaceProvisioningController } from './workspace-provisioning.controller';
import { OpsCenterServiceJwtGuard, ProvisioningEnabledGuard } from './workspace-provisioning.auth';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';

/**
 * The provisioning RBAC surface: the per-workspace policy + the gate other write
 * surfaces (agents, mailboxes) call to authorize a provisioning action. Exports
 * ProvisioningPolicyService so AgentsModule / MailboxAccountsModule can gate.
 * PrismaService is global.
 */
@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [ProvisioningPolicyController, WorkspaceProvisioningController],
  providers: [
    ProvisioningPolicyService,
    WorkspaceProvisioningService,
    ProvisioningEnabledGuard,
    OpsCenterServiceJwtGuard,
  ],
  exports: [ProvisioningPolicyService],
})
export class ProvisioningModule {}
