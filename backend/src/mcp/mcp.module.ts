import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { EmailModule } from '../email/email.module';

@Module({
  // EmailModule exports EmailService so the contract MCP tools run the SAME SoR
  // + agent-inbox logic a future REST surface would (one implementation, one RLS
  // path). WorkspaceModule provides the membership gate; AuthModule the JWT guard.
  imports: [AuthModule, WorkspaceModule, EmailModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
