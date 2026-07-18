import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { EmailModule } from '../email/email.module';
import { MailProviderModule } from '../mail-provider/mail-provider.module';
import { StalwartModule } from '../stalwart/stalwart.module';
import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';
import { SchedulingWorker } from './scheduling.worker';

@Module({
  imports: [AuthModule, WorkspaceModule, StalwartModule, MailProviderModule, EmailModule],
  controllers: [SchedulingController],
  providers: [SchedulingService, SchedulingWorker],
  exports: [SchedulingService],
})
export class SchedulingModule {}
