import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { ActionEventPayload } from '@vantikhq/types';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

import {
  DELIVER_NOTIFICATION_JOB,
  DELIVERY_ATTEMPTS,
  DELIVERY_BACKOFF_MS,
  NOTIFICATIONS_QUEUE,
} from './notifications.interface';

/**
 * What a service calls when something happened that people should hear about.
 *
 * This replaces `tasks.trigger('notification', …)` at every call site. The
 * shape is deliberately the same — one call, no result awaited — so that the
 * services doing the notifying did not have to learn anything new. What changed
 * is where it goes: redis, which the stack already requires, instead of an
 * optional service that is not deployed.
 */
@Injectable()
export class NotificationsQueue {
  private readonly logger: LoggerService = new LoggerService(
    'NotificationsQueue',
  );

  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Enqueues a notification event.
   *
   * Awaited by callers or not, the enqueue is the only part that must not be
   * silently lost — so a failure to reach redis is logged here rather than
   * becoming an unhandled rejection, which is precisely how the trigger.dev
   * version stayed invisible for so long.
   */
  async deliver(payload: ActionEventPayload) {
    try {
      await this.queue.add(
        DELIVER_NOTIFICATION_JOB,
        { payload },
        {
          attempts: DELIVERY_ATTEMPTS,
          backoff: { type: 'fixed', delay: DELIVERY_BACKOFF_MS },
          removeOnComplete: true,
          // Kept, and bounded. A queue that discards its failures looks idle and
          // healthy while nothing is being delivered — the symptom this whole
          // change exists to remove.
          removeOnFail: 100,
        },
      );
    } catch (error) {
      this.logger.error({
        message: `Could not enqueue a notification: ${error}`,
        where: 'NotificationsQueue.deliver',
        error: error instanceof Error ? error : undefined,
      });
    }
  }
}
