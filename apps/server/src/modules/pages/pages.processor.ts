import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import PageEntriesService from './page-entries.service';
import {
  DECAY_CRON,
  DECAY_JOB,
  DECAY_JOB_ID,
  PAGES_QUEUE,
  PROPOSED_ENTRY_EXPIRY_DAYS,
  STANDING_ENTRY_DECAY_DAYS,
} from './pages.interface';

/**
 * The scheduler for the decay pass.
 *
 * A Bull repeatable job rather than an in-process timer, because Redis is what
 * makes the schedule survive a restart *and* stay singular across replicas. An
 * in-process cron would fire once per replica, and a bank being groomed three
 * times a night by three servers is a bank whose logs cannot be trusted to say
 * what happened to an entry.
 */
@Injectable()
export class PagesScheduler implements OnModuleInit {
  private readonly logger: LoggerService = new LoggerService('PagesScheduler');

  constructor(@InjectQueue(PAGES_QUEUE) private pagesQueue: Queue) {}

  async onModuleInit() {
    // Matching the pattern the vector collections already set at boot: setup
    // that fails should degrade the feature, not stop the server coming up.
    try {
      await this.scheduleDecay();
    } catch (error) {
      this.logger.error({
        message: `Could not schedule the knowledge decay pass: ${error}`,
        where: 'PagesScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private async scheduleDecay() {
    // Clearing first is what makes the cron *configurable* rather than merely
    // set once. Bull keys a repeatable job by its cron expression, so changing
    // PAGE_DECAY_CRON without this leaves the old schedule registered and the
    // pass quietly runs on both.
    const existing = await this.pagesQueue.getRepeatableJobs();
    await Promise.all(
      existing
        .filter((job) => job.name === DECAY_JOB)
        .map((job) => this.pagesQueue.removeRepeatableByKey(job.key)),
    );

    const cron = DECAY_CRON.trim();
    if (!cron || cron.toLowerCase() === 'off') {
      this.logger.info({
        message:
          'Knowledge decay is disabled (PAGE_DECAY_CRON is off); untriaged ' +
          'entries will accumulate until someone triages them',
        where: 'PagesScheduler.scheduleDecay',
      });
      return;
    }

    await this.pagesQueue.add(
      DECAY_JOB,
      {},
      {
        jobId: DECAY_JOB_ID,
        repeat: { cron },
        removeOnComplete: true,
        // Failures are kept, successes are not. Discarding a failed run left
        // the queue looking idle and healthy while decay had in fact stopped —
        // the same symptom as no scheduler at all. Bounded so a pass that fails
        // every night cannot fill Redis.
        removeOnFail: 20,
      },
    );

    this.logger.info({
      message:
        `Knowledge decay scheduled (${cron}): untriaged entries archive after ` +
        `${PROPOSED_ENTRY_EXPIRY_DAYS}d, unserved standing entries after ` +
        `${STANDING_ENTRY_DECAY_DAYS}d`,
      where: 'PagesScheduler.scheduleDecay',
    });
  }
}

@Processor(PAGES_QUEUE)
export class PagesProcessor {
  private readonly logger: LoggerService = new LoggerService('PagesProcessor');

  constructor(private pageEntriesService: PageEntriesService) {}

  /**
   * Runs decay across every workspace.
   *
   * Deliberately unscoped: the windows are a property of the deployment, not of
   * a workspace, and a per-workspace fan-out would need a job per workspace to
   * express the same thing. `runDecay` is idempotent, so a retry after a
   * partial failure re-archives what it already archived and changes nothing.
   */
  @Process(DECAY_JOB)
  async handleDecay() {
    let expiredProposed: number;
    let archivedStanding: number;

    try {
      ({ expiredProposed, archivedStanding } =
        await this.pageEntriesService.runDecay());
    } catch (error) {
      // Said out loud, because the alternative is silence. The only other
      // signal this pass gives is the line below, and "no line" reads exactly
      // like "no schedule" — the bug this file was written to fix. Rethrown so
      // Bull still records the run as failed.
      this.logger.error({
        message: `Knowledge decay pass failed: ${error}`,
        where: 'PagesProcessor.handleDecay',
        error: error instanceof Error ? error : undefined,
      });

      throw error;
    }

    this.logger.info({
      message:
        `Knowledge decay archived ${expiredProposed} untriaged and ` +
        `${archivedStanding} unserved standing entr(ies)`,
      where: 'PagesProcessor.handleDecay',
    });
  }
}
