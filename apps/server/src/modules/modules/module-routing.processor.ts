import { InjectQueue, Process, Processor } from '@nestjs/bull';
import {
  CodeChangeEvent,
  EventBody,
  IntegrationPayloadEventType,
} from '@vantikhq/types';
import { Job, Queue } from 'bull';

import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LoggerService } from 'modules/logger/logger.service';
import {
  CODE_LANDED_JOB,
  type CodeLandedJob,
  codeLandedJobOptions,
  PAGES_QUEUE,
} from 'modules/pages/pages.interface';

import { MODULE_ROUTING_QUEUE } from './module-routing.queue';
import { ModuleRoutingService } from './module-routing.service';

interface RouteWebhookJob {
  sourceName: string;
  eventBody: EventBody;
  integrationAccountId: string;
  workspaceId: string;
}

/**
 * Asks the integration which files a change touched, routes them to modules,
 * and has the knowledge citing them checked once the change has landed.
 *
 * This is the slow half of what used to sit inside the webhook handler: the
 * request to the provider for the changed files, which is paged and can be
 * thirty round trips. Nothing waits for it here.
 */
@Processor(MODULE_ROUTING_QUEUE)
export class ModuleRoutingProcessor {
  private readonly logger: LoggerService = new LoggerService(
    'ModuleRoutingProcessor',
  );

  constructor(
    private integrations: IntegrationsService,
    private moduleRouting: ModuleRoutingService,
    @InjectQueue(PAGES_QUEUE) private pagesQueue: Queue,
  ) {}

  @Process('routeWebhook')
  async routeWebhook(job: Job<RouteWebhookJob>) {
    const { sourceName, eventBody, integrationAccountId, workspaceId } =
      job.data;

    const change = await this.integrations.loadIntegration(sourceName, {
      event: IntegrationPayloadEventType.GET_CODE_CHANGE,
      integrationAccountId,
      eventBody,
    });

    // An integration that does not answer GET_CODE_CHANGE, and a webhook that
    // describes something other than a change to code, both land here. That is
    // the ordinary case for most webhooks and it is not a fault, so it must not
    // be a failed job that Bull then retries twice.
    if (!change) {
      return;
    }

    // Routing modules to issues is for the changes that name one, as before.
    if (change.issueKeys?.length) {
      await this.moduleRouting.routeCodeChange(change, workspaceId);

      this.logger.info({
        message: `Routed a ${sourceName} webhook to modules`,
        where: 'ModuleRoutingProcessor.routeWebhook',
      });
    }

    // Every change that landed on the default branch, named issue or not, has
    // the knowledge citing its files checked against the commit it landed as.
    if (
      change.mergeSha &&
      change.onDefaultBranch &&
      change.changedPaths?.length
    ) {
      await this.checkKnowledge(change, workspaceId);
    }
  }

  private async checkKnowledge(change: CodeChangeEvent, workspaceId: string) {
    const job: CodeLandedJob = {
      workspaceId,
      externalRepoId: change.externalRepoId,
      sha: change.mergeSha,
      changedPaths: change.changedPaths,
    };

    await this.pagesQueue.add(CODE_LANDED_JOB, job, codeLandedJobOptions(job));

    this.logger.info({
      message: `Queued a knowledge check for ${change.changedPaths.length} path(s) landed at ${change.mergeSha}`,
      where: 'ModuleRoutingProcessor.checkKnowledge',
    });
  }
}
