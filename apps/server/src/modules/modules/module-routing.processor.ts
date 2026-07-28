import { Process, Processor } from '@nestjs/bull';
import { EventBody, IntegrationPayloadEventType } from '@vantikhq/types';
import { Job } from 'bull';

import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LoggerService } from 'modules/logger/logger.service';

import { MODULE_ROUTING_QUEUE } from './module-routing.queue';
import { ModuleRoutingService } from './module-routing.service';

interface RouteWebhookJob {
  sourceName: string;
  eventBody: EventBody;
  integrationAccountId: string;
  workspaceId: string;
}

/**
 * Asks the integration which files a change touched, and routes them to modules.
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
    if (!change?.issueKeys?.length) {
      return;
    }

    await this.moduleRouting.routeCodeChange(change, workspaceId);

    this.logger.info({
      message: `Routed a ${sourceName} webhook to modules`,
      where: 'ModuleRoutingProcessor.routeWebhook',
    });
  }
}
