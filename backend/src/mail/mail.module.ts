import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { EmailModule } from '../email/email.module';
import { MailController } from './mail.controller';

/**
 * The human email-client BFF. Reads + compose delegate to EmailService (from
 * EmailModule); JWT + membership guards come from Auth/Workspace modules.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, EmailModule],
  controllers: [MailController],
})
export class MailModule {}
