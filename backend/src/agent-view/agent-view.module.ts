import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { EmailModule } from '../email/email.module';
import { AgentViewController } from './agent-view.controller';
import { AgentViewService } from './agent-view.service';

@Module({
  imports: [AuthModule, WorkspaceModule, EmailModule],
  controllers: [AgentViewController],
  providers: [AgentViewService],
})
export class AgentViewModule {}
