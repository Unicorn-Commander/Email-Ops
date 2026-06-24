import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AgentControlsController } from './agent-controls.controller';
import { AgentControlsService } from './agent-controls.service';

/**
 * The agent-controls surface — the workspace kill switch + the activity/audit
 * feed. JWT + membership guarded; PrismaService is global. The kill switch itself
 * is enforced in EmailService.composeEmail (reads Workspace.agentsPaused).
 */
@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [AgentControlsController],
  providers: [AgentControlsService],
  exports: [AgentControlsService],
})
export class AgentControlsModule {}
