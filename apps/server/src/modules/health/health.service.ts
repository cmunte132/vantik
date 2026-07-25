import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { Client as TypesenseClient } from 'typesense';

import { CacheService } from 'modules/cache/cache.service';
import { LoggerService } from 'modules/logger/logger.service';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  dependencies: Record<string, DependencyStatus>;
}

/**
 * A dependency that hangs must not hang the probe. Without this an
 * unreachable host holds the connection open until the OS timeout and the
 * orchestrator's own probe timeout fires first, which reports the whole
 * container as unhealthy without ever saying which dependency was at fault.
 */
const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`check timed out after ${CHECK_TIMEOUT_MS}ms`)),
        CHECK_TIMEOUT_MS,
      ).unref(),
    ),
  ]);
}

@Injectable()
export class HealthService {
  private readonly logger = new LoggerService(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly typesense: TypesenseClient,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const checks: Array<[string, Promise<unknown>]> = [
      ['postgres', this.prisma.$queryRaw`SELECT 1`],
      ['redis', this.cache.ping()],
      ['typesense', this.typesense.health.retrieve()],
    ];

    // Run them together: three sequential two-second timeouts would put the
    // worst case past most orchestrators' probe timeout.
    const results = await Promise.all(
      checks.map(async ([name, work]) => {
        try {
          await withTimeout(work);
          return [name, 'up' as DependencyStatus] as const;
        } catch (error) {
          this.logger.warn({
            message: `Readiness check failed for ${name}`,
            where: 'HealthService.readiness',
            error: error instanceof Error ? error : new Error(String(error)),
          });
          return [name, 'down' as DependencyStatus] as const;
        }
      }),
    );

    const dependencies = Object.fromEntries(results) as Record<
      string,
      DependencyStatus
    >;

    return {
      status: results.every(([, state]) => state === 'up')
        ? 'ready'
        : 'not_ready',
      dependencies,
    };
  }
}
