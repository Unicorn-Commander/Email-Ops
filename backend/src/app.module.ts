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
import { McpModule } from './mcp/mcp.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AgentInboxModule } from './agent-inbox/agent-inbox.module';
import { AgentsModule } from './agents/agents.module';
import { EmailHealthModule } from './email-health/email-health.module';
import { AgentControlsModule } from './agent-controls/agent-controls.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { MailboxAccountsModule } from './mailbox-accounts/mailbox-accounts.module';
import { MailModule } from './mail/mail.module';

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
    // The human email-client BFF (read your inboxes + compose; degrade-clean).
    MailModule,
    // MCP last so it can consume the contract + agent-inbox tools.
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
