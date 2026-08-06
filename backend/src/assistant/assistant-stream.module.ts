import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { EmailModule } from '../email/email.module';
import { ConnectedAccountsModule } from '../connected-accounts/connected-accounts.module';
import { AssistantStreamController } from './assistant-stream.controller';

/**
 * The streaming + action-taking assistant surface.
 *
 * A leaf module (nothing imports it) so it can safely depend on BOTH EmailModule
 * (EmailService — the agent-inbox staging path) and ConnectedAccountsModule (the
 * Cleaner Engine port — the chat stream) without reintroducing the EmailModule ↔
 * ConnectedAccountsModule cycle. Guards come from Auth/Workspace modules.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, EmailModule, ConnectedAccountsModule],
  controllers: [AssistantStreamController],
})
export class AssistantStreamModule {}
