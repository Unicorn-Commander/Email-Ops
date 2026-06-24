import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { EmailModule } from '../email/email.module';
import { ConnectedAccountsModule } from '../connected-accounts/connected-accounts.module';
import { AgentsModule } from '../agents/agents.module';
import { EmailHealthModule } from '../email-health/email-health.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { MailboxAccountsModule } from '../mailbox-accounts/mailbox-accounts.module';
import { MailTriageModule } from '../mail-triage/mail-triage.module';

@Module({
  // EmailModule exports EmailService so the contract MCP tools run the SAME SoR
  // + agent-inbox logic a future REST surface would (one implementation, one RLS
  // path). ConnectedAccountsModule exports the connected-account service + the
  // Cleaner Engine port. ProvisioningModule + MailboxAccountsModule back the
  // conversational-provisioning write tools (policy gate + the canonical apply
  // path). WorkspaceModule provides the membership gate; AuthModule the JWT guard.
  imports: [
    AuthModule,
    WorkspaceModule,
    EmailModule,
    ConnectedAccountsModule,
    AgentsModule,
    EmailHealthModule,
    ProvisioningModule,
    MailboxAccountsModule,
    // The mail-triage services (folder dispositions + sender block/allow) back
    // the agent-driven triage tools.
    MailTriageModule,
  ],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
