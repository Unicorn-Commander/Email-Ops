import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';
import { WorkspaceModule } from './common/workspace/workspace.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { StalwartModule } from './stalwart/stalwart.module';
import { EmailModule } from './email/email.module';
import { SmsModule } from './sms/sms.module';
import { McpModule } from './mcp/mcp.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AgentInboxModule } from './agent-inbox/agent-inbox.module';
import { AgentsModule } from './agents/agents.module';
import { EmailHealthModule } from './email-health/email-health.module';
import { AgentControlsModule } from './agent-controls/agent-controls.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { ProvisioningRequestsModule } from './provisioning/provisioning-requests.module';
import { MailboxAccountsModule } from './mailbox-accounts/mailbox-accounts.module';
import { MailModule } from './mail/mail.module';
import { MailTriageModule } from './mail-triage/mail-triage.module';
import { SpacesModule } from './spaces/spaces.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { UiCommandsModule } from './ui-commands/ui-commands.module';

@Module({
  imports: [
    // Configuration — global, sourced from .env.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Rate limiting — named throttlers for different security levels.
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 60000, limit: 20 },
      { name: 'long', ttl: 3600000, limit: 200 },
    ]),

    // Core tenancy + identity.
    PrismaModule,
    WorkspaceModule,
    AuthModule,
    HealthModule,
    // The mail engine seam (Stalwart IMAP/JMAP + Postmark lane; degrade-clean).
    StalwartModule,
    // The Email-Ops core domain: the SoR + the EmailOpsPort contract + the
    // agent-inbox approval flow.
    EmailModule,
    // The SMS channel (enterprise/shared-line scope; Twilio + in-house roadmap).
    // Additive + dormant without TWILIO_* env; an SMS send reuses the EXACT email
    // governance — autonomy dial, kill switch, agent-inbox queue, audit log.
    SmsModule,
    // Phase 2, Part A: the provider-webhook receiver (Postmark engagement
    // capture). Provider-authed; inert by default (flag + secret gated).
    WebhooksModule,
    // Phase 2, Part B: the agent-inbox REST surface (JWT + membership guarded),
    // delegating to the same EmailService approval flow the MCP tools use.
    AgentInboxModule,
    // The agent registry surface (the "Agents" view + the autonomy dial): the
    // identity layer behind the approval queue. JWT + membership guarded.
    AgentsModule,
    // The email-steward health surface (engine/mailboxes/queue/agents): a
    // workspace-scoped "how's email?" report, REST + an MCP tool.
    EmailHealthModule,
    // The agent kill switch (Workspace.agentsPaused, enforced in composeEmail) +
    // the agent-mail activity/audit feed.
    AgentControlsModule,
    // The provisioning RBAC control surface (per-workspace policy + the gate the
    // agent/mailbox write surfaces authorize against).
    ProvisioningModule,
    // Mailbox management (human/agent/shared CRUD; policy-gated).
    MailboxAccountsModule,
    // The provisioning approval queue (list/approve/reject; replays an approved
    // request through the canonical apply path). Imported after its dependencies.
    ProvisioningRequestsModule,
    // The human email-client BFF (read your inboxes + compose; degrade-clean).
    MailModule,
    // Mail triage: the app-layer spam/junk seams — folder dispositions
    // (Inbox/Archive/Trash/Spam overlay), the sender block/allow list, and the
    // dormant SpamPort engine seam. Pairs with the mail-engine/migration project.
    MailTriageModule,
    // Spaces: soft, overlapping groupings of mailboxes + agents (PERSONAL /
    // TEAM views) inside the workspace — the top-bar switcher scopes /mail + the
    // agents view to the active Space. JWT + membership guarded.
    SpacesModule,
    // Multi-org tenancy: create-org, the org switcher, members + per-org RBAC,
    // and the invite → accept flow on top of the Workspace + Membership
    // foundation. Top-level workspaces + invites controllers (org CRUD is not
    // workspace-scoped); RBAC is enforced against the caller's real role.
    WorkspacesModule,
    // The "agent controls the UI" channel: the drain endpoint a cockpit polls +
    // the UiCommandService the MCP ui_* tools enqueue into. Before McpModule so
    // the MCP server can consume UiCommandService.
    UiCommandsModule,
    // MCP last so it can consume the contract + agent-inbox + ui_* tools.
    McpModule,
  ],
  providers: [
    // Rate limiting globally via guard.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
