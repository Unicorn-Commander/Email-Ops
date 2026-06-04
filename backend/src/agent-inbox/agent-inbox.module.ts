import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AgentInboxController } from './agent-inbox.controller';

/**
 * The agent-inbox REST surface (Phase 2, Part B).
 *
 * Exposes workspaces/:workspaceId/agent-inbox under the user-JWT + workspace-
 * membership guards, delegating every action to the EXISTING EmailService
 * approval flow (listAgentInbox / approveAgentInboxItem / rejectAgentInboxItem)
 * — the SAME implementation the MCP tools use, so an agent and a human hit one
 * set of rules + one RLS path. No approval logic is duplicated here.
 *
 * Imports:
 *   - AuthModule      → JwtAuthGuard / passport JWT strategy (the auth chokepoint).
 *   - WorkspaceModule → MembershipService + WorkspaceMembershipGuard (the gate).
 *   - EmailModule     → EmailService (the approval flow + RLS write path).
 */
@Module({
  imports: [AuthModule, WorkspaceModule, EmailModule],
  controllers: [AgentInboxController],
})
export class AgentInboxModule {}
