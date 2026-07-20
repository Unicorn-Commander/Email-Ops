import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpManifestController } from './mcp-manifest.controller';
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
import { UiCommandsModule } from '../ui-commands/ui-commands.module';
import { MailEngineAdminModule } from '../mail-engine-admin/mail-engine-admin.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AgentViewModule } from '../agent-view/agent-view.module';
import { MailRulesModule } from '../mail-rules/mail-rules.module';
import { TrustedCorrespondentsModule } from '../trusted-correspondents/trusted-correspondents.module';

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
    // UiCommandsModule exports UiCommandService so the ui_* tools can enqueue a
    // command into the caller's cockpit (the "agent controls the UI" surface).
    UiCommandsModule,
    // MailEngineAdminModule binds MailEngineAdminPort (JamesAdminClient) so the
    // mail-engine admin MCP tools can manage domains, accounts, and quotas.
    MailEngineAdminModule,
    // SchedulingModule + AgentViewModule export SchedulingService + AgentViewService
    // so the snooze / send-later / per-agent-mailbox MCP tools call the SAME services
    // the human REST routes use (one implementation, one RLS path).
    SchedulingModule,
    AgentViewModule,
    // MailRulesModule exports MailRulesService so the mail-rules MCP tools run the
    // SAME rule CRUD (validation + per-mailbox fence) the human REST routes use
    // (one implementation, one RLS path).
    MailRulesModule,
    // TrustedCorrespondentsModule exports the Wave-7 trust CRUD service so the
    // list/trust/untrust MCP tools share the REST implementation + RLS path.
    TrustedCorrespondentsModule,
  ],
  // McpManifestController is the PUBLIC per-environment federation-manifest route
  // (mcp_endpoint derived from the host / PUBLIC_BASE_URL) — fixes prod advertising
  // the dogfood endpoint. No JWT (discovery must be fetchable); serves the bundled
  // MCP_MANIFEST_CATALOG, needs no injected services.
  controllers: [McpController, McpManifestController],
  providers: [McpService],
})
export class McpModule {}
