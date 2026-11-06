import { ConfigService } from '@nestjs/config';
import { HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health';

describe('HealthController memory thresholds', () => {
  it('uses HEALTH_RSS_LIMIT_MB and HEALTH_HEAP_LIMIT_MB overrides', async () => {
    const health = {
      check: jest.fn(async (checks: Array<() => unknown>) => {
        for (const check of checks) await check();
        return { status: 'ok' };
      }),
    } as unknown as HealthCheckService;
    const memory = {
      checkHeap: jest.fn().mockReturnValue({ status: 'up' }),
      checkRSS: jest.fn().mockReturnValue({ status: 'up' }),
    } as unknown as MemoryHealthIndicator;
    const prismaHealth = {
      isHealthy: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
    } as unknown as PrismaHealthIndicator;
    const config = new ConfigService({
      HEALTH_RSS_LIMIT_MB: '1537',
      HEALTH_HEAP_LIMIT_MB: '333',
    });
    const controller = new HealthController(health, memory, prismaHealth, config);

    await controller.check();

    expect(memory.checkHeap).toHaveBeenCalledWith('memory_heap', 333 * 1024 * 1024);
    expect(memory.checkRSS).toHaveBeenCalledWith('memory_rss', 1537 * 1024 * 1024);
  });

  it('keeps the current 200 MB heap default while raising the RSS default to 1536 MB', async () => {
    const health = {
      check: jest.fn(async (checks: Array<() => unknown>) => {
        for (const check of checks) await check();
        return { status: 'ok' };
      }),
    } as unknown as HealthCheckService;
    const memory = {
      checkHeap: jest.fn().mockReturnValue({ status: 'up' }),
      checkRSS: jest.fn().mockReturnValue({ status: 'up' }),
    } as unknown as MemoryHealthIndicator;
    const prismaHealth = {
      isHealthy: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
    } as unknown as PrismaHealthIndicator;
    const controller = new HealthController(health, memory, prismaHealth, new ConfigService());

    await controller.check();

    expect(memory.checkHeap).toHaveBeenCalledWith('memory_heap', 200 * 1024 * 1024);
    expect(memory.checkRSS).toHaveBeenCalledWith('memory_rss', 1536 * 1024 * 1024);
  });
});
