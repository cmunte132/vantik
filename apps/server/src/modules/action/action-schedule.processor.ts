import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ActionScheduleStatusEnum, ActionTypesEnum } from '@vantikhq/types';
import { Job, Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { prepareTriggerPayload } from 'modules/action-event/action-event.utils';
import { ActionsQueue } from 'modules/action-event/actions.queue';
import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LoggerService } from 'modules/logger/logger.service';

export const ACTION_SCHEDULES_QUEUE = 'action-schedules';
export const RUN_SCHEDULE_JOB = 'runActionSchedule';

/**
 * Registers every active action schedule as a Bull repeatable job at boot.
 *
 * Schedules used to be created through trigger.dev's HTTP API, and
 * `ActionSchedule.scheduleId` held the id it returned — a foreign key into a
 * service that is optional and, on a default deployment, is not running. So a
 * scheduled action was registered nowhere and fired never.
 *
 * This follows the convention the README already states for Vantik's own
 * scheduled work: a Bull repeatable on the redis the stack requires, cleared
 * and re-added at start so a changed cron does not leave the old schedule
 * registered alongside the new one.
 */
@Injectable()
export class ActionScheduleScheduler implements OnModuleInit {
  private readonly logger = new LoggerService('ActionScheduleScheduler');

  constructor(
    @InjectQueue(ACTION_SCHEDULES_QUEUE) private queue: Queue,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Setup that fails should degrade the feature, not stop the server coming
    // up — the same posture the pages and cycles schedulers take.
    try {
      await this.registerAll();
    } catch (error) {
      this.logger.error({
        message: `Could not register action schedules: ${error}`,
        where: 'ActionScheduleScheduler.onModuleInit',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  async registerAll() {
    const existing = await this.queue.getRepeatableJobs();
    await Promise.all(
      existing
        .filter((job) => job.name === RUN_SCHEDULE_JOB)
        .map((job) => this.queue.removeRepeatableByKey(job.key)),
    );

    const schedules = await this.prisma.actionSchedule.findMany({
      where: { deleted: null, status: ActionScheduleStatusEnum.ACTIVE },
      include: { action: true },
    });

    for (const schedule of schedules) {
      if (!schedule.cron) {
        continue;
      }

      await this.register(schedule.id, schedule.cron, schedule.timezone);
    }

    this.logger.info({
      message: `Registered ${schedules.length} action schedule(s)`,
      where: 'ActionScheduleScheduler.registerAll',
    });
  }

  /** Adding and removing one, so create/update/delete stay live without a restart. */
  async register(scheduleId: string, cron: string, timezone?: string) {
    await this.remove(scheduleId);

    await this.queue.add(
      RUN_SCHEDULE_JOB,
      { scheduleId },
      {
        jobId: scheduleId,
        repeat: { cron, ...(timezone ? { tz: timezone } : {}) },
        removeOnComplete: true,
        removeOnFail: 20,
      },
    );
  }

  async remove(scheduleId: string) {
    const existing = await this.queue.getRepeatableJobs();

    await Promise.all(
      existing
        .filter((job) => job.id === scheduleId)
        .map((job) => this.queue.removeRepeatableByKey(job.key)),
    );
  }
}

@Processor(ACTION_SCHEDULES_QUEUE)
export class ActionScheduleProcessor {
  constructor(
    private prisma: PrismaService,
    private integrationsService: IntegrationsService,
    private actionsQueue: ActionsQueue,
  ) {}

  @Process(RUN_SCHEDULE_JOB)
  async handleSchedule(job: Job<{ scheduleId: string }>) {
    const schedule = await this.prisma.actionSchedule.findUnique({
      where: { id: job.data.scheduleId },
      include: { action: true },
    });

    // A schedule that was deleted or paused between firings is not an error.
    // The repeatable is removed on the next boot, and the run is skipped now.
    if (
      !schedule ||
      schedule.deleted ||
      schedule.status !== ActionScheduleStatusEnum.ACTIVE
    ) {
      return { message: 'Schedule is no longer active' };
    }

    const payload = await prepareTriggerPayload(
      this.prisma,
      this.integrationsService,
      schedule.action.id,
    );

    return await this.actionsQueue.run({
      slug: schedule.action.slug,
      workspaceId: schedule.action.workspaceId,
      actionId: schedule.action.id,
      event: ActionTypesEnum.ON_SCHEDULE,
      payload: { ...payload, scheduleId: schedule.id },
    });
  }
}
