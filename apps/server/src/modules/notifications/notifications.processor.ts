import { Process, Processor } from '@nestjs/bull';
import { ActionEventPayload } from '@vantikhq/types';
import { Job } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { deliverNotification } from './delivery';
import {
  DELIVER_NOTIFICATION_JOB,
  NOTIFICATIONS_QUEUE,
} from './notifications.interface';

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor {
  private readonly logger: LoggerService = new LoggerService(
    'NotificationsProcessor',
  );

  constructor(private prisma: PrismaService) {}

  /**
   * Delivers one notification, in the server process, on the stack's redis.
   *
   * Errors are logged and rethrown rather than swallowed. Rethrowing is what
   * lets Bull retry and, after the last attempt, keep the job on the failed set
   * where somebody can find it. Swallowing is what the previous arrangement
   * effectively did — a fire-and-forget call to an absent service, caught by
   * the process-wide `unhandledRejection` handler in `main.ts` and logged as a
   * bare "Connection error" with nothing naming the notification it lost.
   */
  @Process(DELIVER_NOTIFICATION_JOB)
  async handleDeliverNotification(job: Job<{ payload: ActionEventPayload }>) {
    const { payload } = job.data;

    try {
      const result = await deliverNotification(this.prisma, payload);

      if (!result.emailDelivered) {
        // Not a job failure. The inbox row is written, and that is the half a
        // person sees in the product; an unreachable SMTP host is a
        // deployment's business and must not cost somebody their notification.
        this.logger.warn({
          message: `Notification delivered in-app but not by email: ${result.emailError}`,
          where: 'NotificationsProcessor.handleDeliverNotification',
        });
      }

      return result;
    } catch (error) {
      this.logger.error({
        message:
          `Could not deliver a notification for issue ` +
          `${payload?.notificationData?.issueId}: ${error}`,
        where: 'NotificationsProcessor.handleDeliverNotification',
        error: error instanceof Error ? error : undefined,
      });
      throw error;
    }
  }
}
