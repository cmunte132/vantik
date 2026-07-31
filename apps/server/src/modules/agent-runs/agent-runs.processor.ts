import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import {
  AGENT_RUN_LEASE_SWEEP_CRON,
  AGENT_RUN_LEASE_SWEEP_JOB,
  AGENT_RUN_LEASE_SWEEP_JOB_ID,
  AGENT_RUNS_QUEUE,
} from './agent-runs.interface';
import { AgentRunsService } from './agent-runs.service';

/**
 * Expires runs whose lease has lapsed.
 *
 * This is the half of the lease protocol that cannot live in the runner: a
 * process that has stopped cannot report that it stopped. Without a
 * server-side sweep a laptop that closed its lid holds a queued issue for
 * ever, and the retry the user is waiting for never happens.
 *
 * A Bull repeatable job on the Redis the stack already requires, in the shape
 * of the cycle maintenance and knowledge decay passes. Deliberately not
 * trigger.dev: it is optional in every deployment this repo ships, absent from
 * the compose file, and a lease sweep that silently never runs is worse than
 * no lease at all — the feature would appear to work right up until something
 * crashed.
 */
@Injectable()
export class AgentRunsScheduler implements OnModuleInit {
  private readonly logger = new LoggerService('AgentRunsScheduler');

  constructor(@InjectQueue(AGENT_RUNS_QUEUE) private queue: Queue) {}

  async onModuleInit() {
    // Scheduling that fails should degrade the feature, not stop the server
    // coming up.
    try {
      await this.scheduleSweep();
    } catch (error) {
      this.logger.error({
        message: `Could not schedule the agent run lease sweep: ${error}`,
        where: 'AgentRunsScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private async scheduleSweep() {
    // Bull keys a repeatable job by its cron expression, so changing the
    // schedule without clearing first leaves the old one registered and the
    // sweep runs on both.
    const existing = await this.queue.getRepeatableJobs();
    await Promise.all(
      existing
        .filter((job) => job.name === AGENT_RUN_LEASE_SWEEP_JOB)
        .map((job) => this.queue.removeRepeatableByKey(job.key)),
    );

    const cron = AGENT_RUN_LEASE_SWEEP_CRON.trim();
    if (!cron || cron.toLowerCase() === 'off') {
      this.logger.info({
        message:
          'Agent run lease sweeping is disabled (AGENT_RUN_LEASE_SWEEP_CRON ' +
          'is off); a runner that stops will hold its run indefinitely',
        where: 'AgentRunsScheduler.scheduleSweep',
      });
      return;
    }

    await this.queue.add(
      AGENT_RUN_LEASE_SWEEP_JOB,
      {},
      {
        jobId: AGENT_RUN_LEASE_SWEEP_JOB_ID,
        repeat: { cron },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }
}

@Processor(AGENT_RUNS_QUEUE)
export class AgentRunsProcessor {
  private readonly logger = new LoggerService('AgentRunsProcessor');

  constructor(private agentRuns: AgentRunsService) {}

  @Process(AGENT_RUN_LEASE_SWEEP_JOB)
  async sweep() {
    const { expired, requeued } = await this.agentRuns.expireLapsedLeases();

    // Silent when there is nothing to do, which is the common case — a sweep
    // logging every minute would bury everything else.
    if (expired > 0) {
      this.logger.info({
        message: `Expired ${expired} agent run(s) on a lapsed lease; re-queued ${requeued}`,
        where: 'AgentRunsProcessor.sweep',
      });
    }

    return { expired, requeued };
  }
}
