import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';

/**
 * The Spaces surface (the top-bar switcher + manage panel): soft, overlapping
 * groupings of mailboxes + agents inside the workspace. Exposes
 * workspaces/:workspaceId/spaces under the user-JWT + workspace-membership
 * guards. SpacesService owns the RLS write path + the PERSONAL owner fence.
 * Exported so a later surface (e.g. an MCP "switch space" tool) can reuse it.
 *
 * Imports:
 *   - AuthModule      → JwtAuthGuard / passport JWT strategy (the auth chokepoint).
 *   - WorkspaceModule → MembershipService + WorkspaceMembershipGuard (the gate).
 */
@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [SpacesController],
  providers: [SpacesService],
  exports: [SpacesService],
})
export class SpacesModule {}
