import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import { CleanerEngineClient } from './connected-accounts.client';
import { ConnectedAccountsController } from './connected-accounts.controller';
import { AssistantController } from './assistant.controller';
import { ConnectedAccountsService } from './connected-accounts.service';
import { ArchiveStorageService } from './archive-storage.service';
import { ArchiveRetentionService } from './archive-retention.service';
import { NotifyModule } from '../notify/notify.module';

@Module({
  imports: [AuthModule, WorkspaceModule, PrismaModule, ScheduleModule.forRoot(), NotifyModule],
  controllers: [ConnectedAccountsController, AssistantController],
  providers: [
    ConnectedAccountsService,
    ArchiveStorageService,
    ArchiveRetentionService,
    { provide: ConnectedAccountsEnginePort, useClass: CleanerEngineClient },
  ],
  exports: [ConnectedAccountsService, ConnectedAccountsEnginePort],
})
export class ConnectedAccountsModule {}
