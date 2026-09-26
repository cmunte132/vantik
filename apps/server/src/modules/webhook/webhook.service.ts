import { Injectable } from '@nestjs/common';
import {
  EventBody,
  EventHeaders,
  EventQueryParams,
  IntegrationPayloadEventType,
} from '@vantikhq/types';
import { Response } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { IntegrationEventsService } from 'modules/integration-events/integration-events.service';
import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LoggerService } from 'modules/logger/logger.service';
import { ModuleRoutingQueue } from 'modules/modules/module-routing.queue';

@Injectable()
export default class WebhookService {
  private readonly logger: LoggerService = new LoggerService('WebhookService'); // Logger instance for logging

  constructor(
    private prisma: PrismaService,
    private integrations: IntegrationsService,
    private moduleRoutingQueue: ModuleRoutingQueue,
    private integrationEvents: IntegrationEventsService,
  ) {}

  async handleEvents(
    response: Response,
    sourceName: string,
    eventHeaders: EventHeaders,
    eventBody: EventBody,
    eventQueryParams: EventQueryParams,
  ) {
    this.logger.log({
      message: `Received webhook ${sourceName}`,
      where: `WebhookService.handleEvents`,
    });

    const webhookResponse = await this.integrations.loadIntegration(
      sourceName,
      {
        event: IntegrationPayloadEventType.WEBHOOK_RESPONSE,
        eventBody,
        eventHeaders,
        eventQueryParams,
      },
    );

    if (webhookResponse === false) {
      response.status(401).send('Not valid signature');
    } else {
      response.status(200).json(webhookResponse);
    }

    const isSupported = await this.integrations.loadIntegration(sourceName, {
      event: IntegrationPayloadEventType.IS_SUPPORTED_EVENT,
      eventBody,
    });

    if (!isSupported) {
      this.logger.log({
        message: `Received webhook event for ${sourceName} is not one it handles`,
        where: `WebhookService.handleEvents`,
      });
      return false;
    }

    const accountId = await this.integrations.loadIntegration(sourceName, {
      event: IntegrationPayloadEventType.GET_CONNECTED_ACCOUNT_ID,
      data: { eventBody, eventHeaders },
    });

    // A handler that cannot read the account from the body throws, and
    // `loadIntegration` turns that into undefined. Passed to Prisma, undefined
    // drops the filter, and the webhook was handed to whichever account came
    // first, in any workspace.
    if (typeof accountId !== 'string' || accountId.length === 0) {
      this.logger.log({
        message: `Received ${sourceName} webhook names no connected account`,
        where: `WebhookService.handleEvents`,
      });
      return null;
    }

    // Account ids are only unique within a provider: a Discord guild and a
    // GitHub installation can share one. Within GitHub, a personal account's
    // id is a user id, which can equal an installation id, and a webhook is
    // never delivered to a person.
    const integrationAccount = await this.prisma.integrationAccount.findFirst({
      where: {
        accountId,
        integrationDefinition: { slug: sourceName },
        personal: false,
        deleted: null,
      },
      include: { workspace: true, integrationDefinition: true },
    });

    if (!integrationAccount) {
      return null;
    }

    const workspaceId = integrationAccount.workspaceId;

    await this.routeCodeChange(
      sourceName,
      eventBody,
      integrationAccount.id,
      workspaceId,
    );

    await this.integrationEvents.webhookReceived({
      slug: sourceName,
      workspaceId,
      integrationAccountId: integrationAccount.id,
      eventBody,
      eventHeaders,
    });

    return { status: 200 };
  }

  /**
   * This method hands the webhook to the queue that routes it to modules.
   *
   * Only the enqueue happens here. Finding the modules means asking the provider
   * for the files a pull request changed, which is paged and can be thirty round
   * trips — far longer than the ten seconds GitHub waits before it abandons the
   * delivery and sends it again.
   *
   * The try stays, because module routing is an addition to a webhook and never
   * its purpose. A queue that cannot be reached must not stop the behaviour the
   * same webhook drives.
   */
  private async routeCodeChange(
    sourceName: string,
    eventBody: EventBody,
    integrationAccountId: string,
    workspaceId: string,
  ) {
    try {
      await this.moduleRoutingQueue.routeWebhook({
        sourceName,
        eventBody,
        integrationAccountId,
        workspaceId,
      });
    } catch (error) {
      this.logger.error({
        message: `Could not queue the code change of a ${sourceName} webhook`,
        where: 'WebhookService.routeCodeChange',
        error,
      });
    }
  }
}
