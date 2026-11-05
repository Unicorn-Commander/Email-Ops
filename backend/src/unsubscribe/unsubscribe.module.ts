import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { StalwartModule } from '../stalwart/stalwart.module';
import { SuppressionController, UnsubscribeController } from './unsubscribe.controller';
import { SuppressionService } from './suppression.service';

@Module({
  imports: [ConfigModule, AuthModule, WorkspaceModule, StalwartModule],
  controllers: [UnsubscribeController, SuppressionController],
  providers: [SuppressionService],
  exports: [SuppressionService],
})
export class UnsubscribeModule {}
