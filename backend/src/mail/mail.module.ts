import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { EmailModule } from '../email/email.module';
import { MailTriageModule } from '../mail-triage/mail-triage.module';
import { MailController } from './mail.controller';

/**
 * The human email-client BFF. Reads + compose delegate to EmailService (from
 * EmailModule); the bulk archive/trash/spam/inbox actions reuse the EXACT
 * disposition logic from MailTriageModule; JWT + membership guards come from
 * Auth/Workspace modules.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, EmailModule, MailTriageModule],
  controllers: [MailController],
})
export class MailModule {}
