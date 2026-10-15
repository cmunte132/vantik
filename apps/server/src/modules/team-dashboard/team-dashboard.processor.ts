import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import {
  LEARN_THRESHOLDS_JOB,
  LEARN_THRESHOLDS_JOB_ID,
  TEAM_DASHBOARD_LEARN_CRON,
  TEAM_DASHBOARD_QUEUE,
} from './team-dashboard.interface';
import { TeamDashboardService } from './team-dashboard.service';

/**
 * The scheduler for the nightly threshold learning. It is a Bull repeatable
 * job, so the schedule survives a restart and stays singular across replicas.
 */
@Injectable()
export class TeamDashboardScheduler implements OnModuleInit {
  private readonly logger: LoggerService = new LoggerService(
    'TeamDashboardScheduler',
  );

  constructor(@InjectQueue(TEAM_DASHBOARD_QUEUE) private queue: Queue) {}

  async onModuleInit() {
    // Setup that fails should degrade the feature, not stop the server.
    try {
      await this.schedule();
    } catch (error) {
      this.logger.error({
        message: `Could not schedule the threshold learning: ${error}`,
        where: 'TeamDashboardScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private async schedule() {
    // Bull keys a repeatable job by its cron, so clear the old one first.
    const existing = await this.queue.getRepeatableJobs();
    await Promise.all(
      existing
        .filter((job) => job.name === LEARN_THRESHOLDS_JOB)
        .map((job) => this.queue.removeRepeatableByKey(job.key)),
    );

    const cron = TEAM_DASHBOARD_LEARN_CRON.trim();
    if (!cron || cron.toLowerCase() === 'off') {
      this.logger.info({
        message:
          'Threshold learning is disabled (TEAM_DASHBOARD_LEARN_CRON is off)',
        where: 'TeamDashboardScheduler.schedule',
      });
      return;
    }

    await this.queue.add(
      LEARN_THRESHOLDS_JOB,
      {},
      {
        jobId: LEARN_THRESHOLDS_JOB_ID,
        repeat: { cron },
        removeOnComplete: true,
        // Keep failures, so a stopped job does not look idle and healthy.
        removeOnFail: 20,
      },
    );

    this.logger.info({
      message: `Threshold learning scheduled (${cron})`,
      where: 'TeamDashboardScheduler.schedule',
    });
  }
}

@Processor(TEAM_DASHBOARD_QUEUE)
export class TeamDashboardProcessor {
  private readonly logger: LoggerService = new LoggerService(
    'TeamDashboardProcessor',
  );

  constructor(private dashboard: TeamDashboardService) {}

  @Process(LEARN_THRESHOLDS_JOB)
  async handleLearnThresholds() {
    const result = await this.dashboard.recomputeAll();

    this.logger.info({
      message:
        `Threshold learning visited ${result.teams} team(s), ` +
        `${result.failed} failed`,
      where: 'TeamDashboardProcessor.handleLearnThresholds',
    });
  }
}
