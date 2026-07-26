import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import { CyclesAutomationService } from './cycles-automation.service';
import {
  CYCLE_MAINTENANCE_CRON,
  CYCLE_MAINTENANCE_JOB,
  CYCLE_MAINTENANCE_JOB_ID,
  CYCLES_QUEUE,
} from './cycles.interface';

/**
 * The scheduler for the cycle maintenance pass.
 *
 * This lived as a trigger.dev task, which is optional in every deployment this
 * repo ships — it is not in the compose file and the server logs an error and
 * carries on without it. So the one thing keeping automatic cycles moving ran
 * nowhere by default, which is precisely how the feature came to be
 * half-finished: nobody could tell the automation from an automation that was
 * never registered.
 *
 * A Bull repeatable job instead, on the Redis the stack already requires, in
 * the same shape as the knowledge decay pass. It survives a restart and stays
 * singular across replicas — and a duplicated pass here would not be harmless,
 * since replenishment would run twice and hand the team two batches of cycles.
 */
@Injectable()
export class CyclesScheduler implements OnModuleInit {
  private readonly logger: LoggerService = new LoggerService('CyclesScheduler');

  constructor(@InjectQueue(CYCLES_QUEUE) private cyclesQueue: Queue) {}

  async onModuleInit() {
    // Setup that fails should degrade the feature, not stop the server coming
    // up — the same call the pages scheduler makes.
    try {
      await this.scheduleMaintenance();
    } catch (error) {
      this.logger.error({
        message: `Could not schedule the cycle maintenance pass: ${error}`,
        where: 'CyclesScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  private async scheduleMaintenance() {
    // Bull keys a repeatable job by its cron expression, so changing
    // CYCLE_MAINTENANCE_CRON without clearing first leaves the old schedule
    // registered and the pass runs on both.
    const existing = await this.cyclesQueue.getRepeatableJobs();
    await Promise.all(
      existing
        .filter((job) => job.name === CYCLE_MAINTENANCE_JOB)
        .map((job) => this.cyclesQueue.removeRepeatableByKey(job.key)),
    );

    const cron = CYCLE_MAINTENANCE_CRON.trim();
    if (!cron || cron.toLowerCase() === 'off') {
      this.logger.info({
        message:
          'Cycle maintenance is disabled (CYCLE_MAINTENANCE_CRON is off); ' +
          'teams on the automatic cadence will not have cycles closed or created',
        where: 'CyclesScheduler.scheduleMaintenance',
      });
      return;
    }

    await this.cyclesQueue.add(
      CYCLE_MAINTENANCE_JOB,
      {},
      {
        jobId: CYCLE_MAINTENANCE_JOB_ID,
        repeat: { cron },
        removeOnComplete: true,
        // Failures kept, successes not: a discarded failed run leaves the queue
        // looking idle and healthy while cycles have in fact stopped rolling.
        removeOnFail: 20,
      },
    );

    this.logger.info({
      message: `Cycle maintenance scheduled (${cron})`,
      where: 'CyclesScheduler.scheduleMaintenance',
    });
  }
}

@Processor(CYCLES_QUEUE)
export class CyclesProcessor {
  private readonly logger: LoggerService = new LoggerService('CyclesProcessor');

  constructor(private cyclesAutomation: CyclesAutomationService) {}

  @Process(CYCLE_MAINTENANCE_JOB)
  async handleMaintenance() {
    const result = await this.cyclesAutomation.runMaintenance();

    this.logger.info({
      message:
        `Cycle maintenance visited ${result.teamsVisited} team(s), closed ` +
        `${result.cyclesClosed} and created ${result.cyclesCreated} cycle(s)`,
      where: 'CyclesProcessor.handleMaintenance',
    });
  }
}
