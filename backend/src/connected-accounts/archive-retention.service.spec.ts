import { CleanupBatchState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ArchiveRetentionService } from './archive-retention.service';

describe('ArchiveRetentionService', () => {
  it('scans expired archives through the BYPASSRLS system client and scopes each mutation', async () => {
    const expired = {
      id: 'batch-expired',
      workspaceId: 'ws-archive',
      archiveBucket: 'archives',
      archiveKey: 'workspaces/ws-archive/archives/batch.zip',
      archiveRetained: false,
      archiveExpiresAt: new Date(Date.now() - 1000),
      state: CleanupBatchState.COMPLETED,
    };
    const tx = {
      cleanupBatch: {
        update: jest.fn().mockResolvedValue({ id: expired.id }),
      },
    };
    const systemClient = {
      cleanupBatch: {
        findMany: jest.fn().mockResolvedValue([expired]),
      },
    };
    const runtimeCleanupBatch = {
      findMany: jest.fn(async () => {
        throw new Error('runtime client must not run the cross-workspace archive scan');
      }),
    };
    const prisma = {
      systemClient,
      cleanupBatch: runtimeCleanupBatch,
      withWorkspace: jest.fn((_workspaceId: string, _ucUid: string | null, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const storage = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ArchiveRetentionService(prisma, storage as any);

    await service.sweepExpiredArchives();

    expect(systemClient.cleanupBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        archiveKey: { not: null },
        archiveRetained: false,
      }),
      take: 100,
      orderBy: { archiveExpiresAt: 'asc' },
    }));
    expect(runtimeCleanupBatch.findMany).not.toHaveBeenCalled();
    expect(storage.deleteObject).toHaveBeenCalledWith(expired.archiveBucket, expired.archiveKey);
    expect(prisma.withWorkspace).toHaveBeenCalledWith('ws-archive', 'archive-retention', expect.any(Function));
    expect(tx.cleanupBatch.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: expired.id },
      data: expect.objectContaining({
        archiveKey: null,
        archiveBucket: null,
      }),
    }));
  });
});
