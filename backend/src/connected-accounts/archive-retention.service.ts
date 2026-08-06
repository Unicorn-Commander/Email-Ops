import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CleanupBatchState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ArchiveStorageService } from './archive-storage.service';

@Injectable()
export class ArchiveRetentionService {
  private readonly logger = new Logger(ArchiveRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ArchiveStorageService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweepExpiredArchives(): Promise<void> {
    const now = new Date();
    // Cross-workspace maintenance scan: intentionally uses the documented
    // ADMIN_DATABASE_URL / BYPASSRLS system connection. Every per-row mutation
    // remains fenced through withWorkspace(row.workspaceId, ...).
    const rows = await this.prisma.systemClient.cleanupBatch.findMany({
      where: {
        archiveKey: { not: null },
        archiveRetained: false,
        archiveExpiresAt: { lt: now },
      },
      take: 100,
      orderBy: { archiveExpiresAt: 'asc' },
    });

    for (const row of rows) {
      if (!row.archiveBucket || !row.archiveKey) continue;
      try {
        await this.storage.deleteObject(row.archiveBucket, row.archiveKey);
        await this.prisma.withWorkspace(row.workspaceId, 'archive-retention', async (tx) => {
          await tx.cleanupBatch.update({
            where: { id: row.id },
            data: {
              archiveKey: null,
              archiveBucket: null,
              archiveBytes: null,
              archiveSha256: null,
              archiveExpiresAt: null,
              backupRef: null,
              backupVerified: false,
              state: row.state === CleanupBatchState.COMPLETED ? row.state : row.state,
            },
          });
        });
        this.logger.log(`Expired cleanup archive batch=${row.id} workspace=${row.workspaceId}`);
      } catch (err) {
        this.logger.warn(`Failed expiring cleanup archive batch=${row.id}: ${(err as Error).message}`);
      }
    }
  }
}
