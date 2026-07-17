import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StalwartModule } from '../stalwart/stalwart.module';
import { MailTriageModule } from '../mail-triage/mail-triage.module';
import { InboundWatcherService } from './inbound-watcher.service';

/**
 * The inbound-watcher plane. Its @Cron is discovered by the app-wide
 * ScheduleModule.forRoot() (registered in ConnectedAccountsModule), so this
 * module only wires the service + its deps. Gated OFF by INBOUND_WATCHER_ENABLED.
 */
@Module({
  imports: [PrismaModule, StalwartModule, MailTriageModule],
  providers: [InboundWatcherService],
  exports: [InboundWatcherService],
})
export class InboundModule {}
