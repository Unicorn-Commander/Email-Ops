import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { EmailModule } from '../email/email.module';
import { DispositionService } from './disposition.service';
import { SenderPolicyService } from './sender-policy.service';
import { MailTriageService } from './mail-triage.service';
import { MailTriageController } from './mail-triage.controller';
import { DormantSpamPort, SpamPort } from './spam.port';

/**
 * Mail triage: the app-layer spam/junk seams (folder dispositions + the sender
 * block/allow list + the dormant SpamPort engine seam). The SpamPort is bound to
 * the dormant impl until the mail engine is stood up; swap the `useClass` for a
 * real adapter then and `classifyInbound` lights up with no other change.
 * Services are exported so the MCP tools (agent-driven triage) reuse them.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, EmailModule],
  controllers: [MailTriageController],
  providers: [
    DispositionService,
    SenderPolicyService,
    MailTriageService,
    { provide: SpamPort, useClass: DormantSpamPort },
  ],
  exports: [DispositionService, SenderPolicyService, MailTriageService, SpamPort],
})
export class MailTriageModule {}
