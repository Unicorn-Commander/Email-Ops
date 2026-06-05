import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import { CleanerEngineClient } from './connected-accounts.client';
import { ConnectedAccountsService } from './connected-accounts.service';

@Module({
  imports: [AuthModule, WorkspaceModule, PrismaModule],
  providers: [
    ConnectedAccountsService,
    { provide: ConnectedAccountsEnginePort, useClass: CleanerEngineClient },
  ],
  exports: [ConnectedAccountsService, ConnectedAccountsEnginePort],
})
export class ConnectedAccountsModule {}
