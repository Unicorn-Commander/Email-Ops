import { Controller, Get, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { SKIP_ALL_THROTTLERS } from '../auth/identity-throttle';
import { HealthCheck, HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';

@ApiTags('health')
// Named throttlers require an explicit map in @nestjs/throttler v5 — a bare
// @SkipThrottle() is a no-op, and omitting `ip` would still enforce the ceiling.
@SkipThrottle(SKIP_ALL_THROTTLERS)
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly heapLimitBytes: number;
  private readonly rssLimitBytes: number;

  constructor(
    private health: HealthCheckService,
    private memory: MemoryHealthIndicator,
    private prismaHealth: PrismaHealthIndicator,
    config: ConfigService,
  ) {
    const heapLimitMb = readPositiveMegabytes(config, 'HEALTH_HEAP_LIMIT_MB', 200);
    const rssLimitMb = readPositiveMegabytes(config, 'HEALTH_RSS_LIMIT_MB', 1536);
    this.heapLimitBytes = heapLimitMb * 1024 * 1024;
    this.rssLimitBytes = rssLimitMb * 1024 * 1024;
    this.logger.log(
      `Health memory limits configured: heap=${heapLimitMb} MB, rss=${rssLimitMb} MB`,
    );
  }

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  @ApiResponse({ status: 503, description: 'Service is unhealthy' })
  check() {
    return this.health.check([
      () => this.prismaHealth.isHealthy('database'),
      () => this.memory.checkHeap('memory_heap', this.heapLimitBytes),
      () => this.memory.checkRSS('memory_rss', this.rssLimitBytes),
    ]);
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Service is live' })
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  @ApiResponse({ status: 503, description: 'Service is not ready' })
  readiness() {
    return this.health.check([() => this.prismaHealth.isHealthy('database')]);
  }
}

function readPositiveMegabytes(config: ConfigService, name: string, fallback: number): number {
  const raw = config.get<string>(name);
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return fallback;
  const value = Number(String(raw).trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
