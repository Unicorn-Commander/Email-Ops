import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { UiCommandsController } from './ui-commands.controller';
import { UiCommandService } from './ui-commands.service';

/**
 * The "agent controls the UI" channel (the AG-UI / frontend-tools seam). Exposes
 * the drain endpoint (workspaces/:workspaceId/ui-commands) under the user-JWT +
 * workspace-membership guards, and exports UiCommandService so the MCP server's
 * `ui_*` tools can enqueue commands.
 *
 * Imports:
 *   - AuthModule      → JwtAuthGuard / passport JWT strategy.
 *   - WorkspaceModule → MembershipService + WorkspaceMembershipGuard (the gate).
 */
@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [UiCommandsController],
  providers: [UiCommandService],
  exports: [UiCommandService],
})
export class UiCommandsModule {}
