import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { StalwartModule } from '../stalwart/stalwart.module';
import { MailRulesController } from './mail-rules.controller';
import { MailRulesService } from './mail-rules.service';

/**
 * The inbound RULES ENGINE plane: per-mailbox rule CRUD (the pinned REST
 * surface) + the applicator the InboundWatcherService runs per new message.
 * The pure evaluation library lives beside this module in rule-engine.ts.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, StalwartModule],
  controllers: [MailRulesController],
  providers: [MailRulesService],
  exports: [MailRulesService],
})
export class MailRulesModule {}
