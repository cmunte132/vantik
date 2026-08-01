import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import {
  ACTIONS_QUEUE,
  RUN_ACTION_JOB,
  type RunActionJob,
} from './actions.interface';

/**
 * Dispatches an action, and hands back the id of the job that will run it.
 *
 * The id matters: `ActionEvent.processedIds` records what an event dispatched,
 * and used to hold trigger.dev run ids. Bull job ids take their place, so the
 * audit trail keeps working and points at something that exists.
 */
@Injectable()
export class ActionsQueue {
  private readonly logger: LoggerService = new LoggerService('ActionsQueue');

  constructor(@InjectQueue(ACTIONS_QUEUE) private readonly queue: Queue) {}

  async run(job: RunActionJob): Promise<string | null> {
    try {
      const added = await this.queue.add(RUN_ACTION_JOB, job, {
        attempts: 3,
        backoff: { type: 'fixed', delay: 5_000 },
        removeOnComplete: true,
        // Kept and bounded. A queue that throws its failures away looks
        // identical to one with nothing wrong.
        removeOnFail: 100,
      });

      return String(added.id);
    } catch (error) {
      // An action that cannot be enqueued must not fail the request that
      // caused it — creating an issue should not 500 because redis blinked.
      // Logged rather than swallowed, which is the mistake the trigger.dev
      // arrangement made in the other direction.
      this.logger.error({
        message: `Could not enqueue action ${job.actionId}: ${error}`,
        where: 'ActionsQueue.run',
        error: error instanceof Error ? error : undefined,
      });

      return null;
    }
  }

  /**
   * Dispatch and wait for the answer.
   *
   * One call site needs this: asking an action to describe the inputs it wants
   * before it can be configured. Everything else is fire-and-forget. Under
   * trigger.dev this was `triggerAndPoll`; here it is Bull's own `finished()`,
   * with a ceiling because a settings form is waiting on the other end.
   */
  async runAndWait(job: RunActionJob, timeoutMs = 30_000): Promise<unknown> {
    const added = await this.queue.add(RUN_ACTION_JOB, job, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });

    return await Promise.race([
      added.finished(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Action ${job.slug} did not answer in time`)),
          timeoutMs,
        ),
      ),
    ]);
  }
}
