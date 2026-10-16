import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import {
  GIT_ISSUES_CRON,
  GIT_ISSUES_JOB,
  GIT_ISSUES_JOB_ID,
  GIT_ISSUES_QUEUE,
} from './git-issues.interface';
import { GitIssuesService } from './git-issues.service';

/**
 * The scheduler for the issue mirror, in the same shape as cycle maintenance:
 * a Bull repeatable job on the Redis the stack already needs, singular across
 * replicas. Two passes at once over one repository would both read an inbox
 * before either deleted it, and apply it twice.
 */
@Injectable()
export class GitIssuesScheduler implements OnModuleInit {
  private readonly logger = new LoggerService('GitIssuesScheduler');

  constructor(@InjectQueue(GIT_ISSUES_QUEUE) private queue: Queue) {}

  async onModuleInit() {
    try {
      await this.schedule();
    } catch (error) {
      this.logger.error({
        message: `Could not schedule the git issue mirror: ${error}`,
        where: 'GitIssuesScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private async schedule() {
    // Bull keys a repeatable job by its cron, so a changed GIT_ISSUES_CRON
    // would otherwise leave the old schedule running beside the new one.
    const existing = await this.queue.getRepeatableJobs();
    await Promise.all(
      existing
        .filter((job) => job.name === GIT_ISSUES_JOB)
        .map((job) => this.queue.removeRepeatableByKey(job.key)),
    );

    const cron = GIT_ISSUES_CRON.trim();
    if (!cron || cron.toLowerCase() === 'off') {
      this.logger.info({
        message:
          'The git issue mirror is disabled (GIT_ISSUES_CRON is off); local ' +
          'repositories will not get refs/vantik/issues, and inboxes will not be read',
        where: 'GitIssuesScheduler.schedule',
      });
      return;
    }

    await this.queue.add(
      GIT_ISSUES_JOB,
      {},
      {
        jobId: GIT_ISSUES_JOB_ID,
        repeat: { cron },
        removeOnComplete: true,
        removeOnFail: 20,
      },
    );

    this.logger.info({
      message: `Git issue mirror scheduled (${cron})`,
      where: 'GitIssuesScheduler.schedule',
    });
  }
}

@Processor(GIT_ISSUES_QUEUE)
export class GitIssuesProcessor {
  constructor(private gitIssues: GitIssuesService) {}

  @Process(GIT_ISSUES_JOB)
  async handleSync() {
    return await this.gitIssues.runPass();
  }
}
