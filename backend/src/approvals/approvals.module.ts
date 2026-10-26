import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { NotifyModule } from '../notify/notify.module';
import { ApprovalTokensService } from './approval-tokens.service';
import { ApprovalLinksService } from './approval-links.service';
import { StandingApprovalsService } from './standing-approvals.service';
import { ApprovalSessionService } from './approval-session.service';
import { ApprovalSessionGuard } from './approval-session.guard';
import { ApprovalController } from './approval.controller';
import { StandingApprovalsController } from './standing-approvals.controller';

@Module({
  imports: [AuthModule, WorkspaceModule, NotifyModule],
  providers: [
    ApprovalTokensService,
    ApprovalLinksService,
    StandingApprovalsService,
    ApprovalSessionService,
    ApprovalSessionGuard,
  ],
  controllers: [ApprovalController, StandingApprovalsController],
  exports: [ApprovalLinksService, StandingApprovalsService],
})
export class ApprovalsModule {}
