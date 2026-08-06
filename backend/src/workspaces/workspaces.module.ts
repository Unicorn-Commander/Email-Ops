import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { WorkspacesController } from './workspaces.controller';
import { InvitesController } from './invites.controller';
import { WorkspacesService } from './workspaces.service';

/**
 * The multi-org tenancy surface (create-org, members + RBAC, invitations) on top
 * of the existing Workspace + Membership foundation. Exposes the top-level
 * `workspaces` (org CRUD + members + invites) and `invites` (invitee accept)
 * controllers. WorkspacesService owns the control-table writes + the app-layer
 * RBAC fence (the caller's real membership role).
 *
 * Imports:
 *   - AuthModule      → JwtAuthGuard / passport JWT strategy.
 *   - WorkspaceModule → MembershipService + WorkspaceMembershipGuard.
 */
@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [WorkspacesController, InvitesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
