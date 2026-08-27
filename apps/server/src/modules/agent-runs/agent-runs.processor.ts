import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import { AgentDelegationService } from './agent-delegation.service';
import {
  AGENT_RUN_LEASE_SWEEP_CRON,
  AGENT_RUN_LEASE_SWEEP_JOB,
  AGENT_RUN_LEASE_SWEEP_JOB_ID,
  AGENT_RUNS_QUEUE,
} from './agent-runs.interface';
import { AgentRunsService, type ExpiredRun } from './agent-runs.service';
import { RunHandbackService } from './run-handback.service';

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

/**
 * What an expired run is owed.
 *
 * The sweep is where a run reaches a terminal state with nobody watching, so
 * it is the one path that has to write the consequences itself: the next
 * attempt, actually handed to a backend rather than left QUEUED, and a word on
 * the issue. Expiry was silent before — `FAILURE_PROSE` has carried a line for
 * `LEASE_LOST` since the lease existed and nothing could render it.
 */
@Processor(AGENT_RUNS_QUEUE)
export class AgentRunsProcessor {
  private readonly logger = new LoggerService('AgentRunsProcessor');

  constructor(
    private agentRuns: AgentRunsService,
    private delegation: AgentDelegationService,
    private handback: RunHandbackService,
  ) {}

  @Process(AGENT_RUN_LEASE_SWEEP_JOB)
  async sweep() {
    const expired = await this.agentRuns.expireLapsedLeases();
    let requeued = 0;

    for (const run of expired) {
      // Retried first, so the comment can say whether a fresh attempt is
      // already running. A reader who sees two runs and one comment that does
      // not mention the second has to work out the relationship themselves.
      const nextAttempt = run.retryable ? await this.retry(run) : null;

      if (nextAttempt) {
        requeued += 1;
      }

      await this.handback
        .post(run.issueId, run.agentUserId, run.id, {
          status: 'EXPIRED',
          failure: 'LEASE_LOST',
          attempt: run.attempt,
          nextAttempt,
        })
        .catch((): undefined => undefined);
    }

    // Silent when there is nothing to do, which is the common case — a sweep
    // logging every minute would bury everything else.
    if (expired.length > 0) {
      this.logger.info({
        message: `Expired ${expired.length} agent run(s) on a lapsed lease; re-queued ${requeued}`,
        where: 'AgentRunsProcessor.sweep',
      });
    }

    return { expired: expired.length, requeued };
  }

  /**
   * The next attempt, or null if it could not be opened.
   *
   * Never throws: one issue whose retry is refused — a run already retried by
   * hand, an executor that has since been unregistered — must not stop the
   * sweep expiring everything else. The attempt is read off the run that came
   * back rather than assumed to be `attempt + 1`.
   */
  private async retry(run: ExpiredRun): Promise<number | null> {
    try {
      const next = await this.delegation.retry(
        run.id,
        { workspaceId: run.workspaceId },
        run.agentUserId,
      );

      return next.attempt;
    } catch (error) {
      this.logger.error({
        message: `Could not re-queue expired agent run ${run.id}: ${error}`,
        where: 'AgentRunsProcessor.retry',
        error: error instanceof Error ? error : undefined,
      });

      return null;
    }
  }
}
