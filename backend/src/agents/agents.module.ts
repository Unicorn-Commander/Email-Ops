import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * The agent registry surface (the "Agents" view + autonomy dial).
 *
 * Exposes workspaces/:workspaceId/agents under the user-JWT + workspace-
 * membership guards. AgentsService owns the RLS write path (via the global
 * PrismaService). Exported so a later layer (compose/approve enforcement of the
 * autonomy dial) can resolve a draftedBy slug → its registered agent.
 *
 * Imports:
 *   - AuthModule      → JwtAuthGuard / passport JWT strategy (the auth chokepoint).
 *   - WorkspaceModule → MembershipService + WorkspaceMembershipGuard (the gate).
 */
@Module({
  imports: [AuthModule, WorkspaceModule, ProvisioningModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
