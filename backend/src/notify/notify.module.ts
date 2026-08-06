import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StableNotifierService } from './stable-notifier.service';
import { StaleApprovalSweepService } from './stale-approval-sweep.service';

/**
 * The NOTIFY plane (Wave 9 — approval notifications to Unicorn Stable).
 *
 * Exports StableNotifierService so the compose/cleanup staging paths (EmailModule,
 * ConnectedAccountsModule) can fire an approval-pending ping. Also registers the
 * hourly StaleApprovalSweepService, whose @Cron is discovered by the app-wide
 * ScheduleModule.forRoot() (registered in ConnectedAccountsModule).
 *
 * Imports only PrismaModule (for the sweep's cross-tenant scan) — no cycle with
 * Email/ConnectedAccounts, which import THIS module for the notifier. Both the
 * notifier and the sweep are DORMANT by default (see the env dials on each).
 */
@Module({
  imports: [PrismaModule],
  providers: [StableNotifierService, StaleApprovalSweepService],
  exports: [StableNotifierService],
})
export class NotifyModule {}
