import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { EventBody } from '@vantikhq/types';
import { Queue } from 'bull';

import { LoggerService } from 'modules/logger/logger.service';

export const MODULE_ROUTING_QUEUE = 'module-routing';

/**
 * Hands a webhook to the background, so that routing it never delays the reply.
 *
 * Reading the modules of a pull request means asking the provider which files it
 * changed, and GitHub pages that answer a hundred files at a time — up to thirty
 * requests for a large one. Doing that inside the webhook handler put all of it
 * in front of the 200, and GitHub abandons a delivery after ten seconds and
 * retries it. So a slow pull request did not merely route slowly: it failed the
 * delivery, and every action the same webhook drives ran again on the retry.
 *
 * Enqueuing is one Redis write. Everything that made the work slow now happens
 * where nothing is waiting for it.
 */
@Injectable()
export class ModuleRoutingQueue {
  private readonly logger: LoggerService = new LoggerService(
    'ModuleRoutingQueue',
  );

  constructor(
    @InjectQueue(MODULE_ROUTING_QUEUE) private readonly queue: Queue,
  ) {}

  async routeWebhook(job: {
    sourceName: string;
    eventBody: EventBody;
    integrationAccountId: string;
    workspaceId: string;
  }) {
    this.logger.info({
      message: `Queueing module routing for a ${job.sourceName} webhook`,
      where: 'ModuleRoutingQueue.routeWebhook',
    });

    await this.queue.add('routeWebhook', job, {
      // A webhook that cannot be routed is worth two more tries — a rate limit
      // and a brief outage at the provider both clear on their own. It is not
      // worth more than that: the next push routes the same issue again.
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
    });
  }
}
