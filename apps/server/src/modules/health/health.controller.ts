import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';

import { HealthService, ReadinessReport } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Readiness: can this instance actually serve traffic? Returns 503 while any
   * dependency is unreachable, which is what stops an orchestrator routing to
   * an instance that would only return errors. Distinct from `GET /`, which is
   * liveness — the process is up — and must stay cheap and dependency-free so
   * a transient database blip does not get the container killed and restarted.
   *
   * `passthrough` keeps Nest's serialisation while still letting the status
   * code depend on the result.
   */
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadinessReport> {
    const report = await this.healthService.readiness();

    res.status(
      report.status === 'ready'
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );

    return report;
  }
}
