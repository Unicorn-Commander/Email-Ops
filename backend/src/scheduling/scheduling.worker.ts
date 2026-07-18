import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';

@Injectable()
export class SchedulingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulingWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly scheduling: SchedulingService) {}

  onModuleInit(): void {
    if ((process.env.SCHEDULING_WORKER_DISABLED ?? '').trim().toLowerCase() === 'true') return;
    const intervalMs = Number.parseInt(process.env.SCHEDULING_WORKER_INTERVAL_MS ?? '30000', 10);
    this.timer = setInterval(() => void this.runOnce(), Number.isFinite(intervalMs) ? intervalMs : 30000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ snoozes: number; scheduledSends: number }> {
    if (this.running) return { snoozes: 0, scheduledSends: 0 };
    this.running = true;
    try {
      const now = new Date();
      const snoozes = await this.scheduling.surfaceDueSnoozes(now);
      const scheduledSends = await this.scheduling.fireDueScheduledSends(now);
      if (snoozes || scheduledSends) {
        this.logger.log(`scheduling sweep: surfaced=${snoozes} sent=${scheduledSends}`);
      }
      return { snoozes, scheduledSends };
    } catch (err) {
      this.logger.warn(`scheduling sweep failed: ${(err as Error).message}`);
      return { snoozes: 0, scheduledSends: 0 };
    } finally {
      this.running = false;
    }
  }
}
