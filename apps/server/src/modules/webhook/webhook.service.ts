import { Injectable } from '@nestjs/common';
import {
  ActionEntity,
  ActionStatusEnum,
  ActionTypesEnum,
  EventBody,
  EventHeaders,
  EventQueryParams,
  IntegrationPayloadEventType,
} from '@vantikhq/types';
import { Response } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { prepareTriggerPayload } from 'modules/action-event/action-event.utils';
import { ActionsQueue } from 'modules/action-event/actions.queue';
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
    private actionsQueue: ActionsQueue,
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

    const isActionSupported = await this.integrations.loadIntegration(
      sourceName,
      {
        event: IntegrationPayloadEventType.IS_ACTION_SUPPORTED_EVENT,
        eventBody,
      },
    );

    if (!isActionSupported) {
      this.logger.log({
        message: `Received webhook event for ${sourceName} is not supported for actions`,
        where: `WebhookService.handleEvents`,
      });
      return false;
    }

    const accountId = await this.integrations.loadIntegration(sourceName, {
      event: IntegrationPayloadEventType.GET_CONNECTED_ACCOUNT_ID,
      data: { eventBody, eventHeaders },
    });

    const integrationAccount = await this.prisma.integrationAccount.findFirst({
      where: { accountId, deleted: null },
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

    const actionEntities = await this.prisma.actionEntity.findMany({
      where: {
        type: ActionTypesEnum.SOURCE_WEBHOOK,
        action: {
          workspaceId,
          status: ActionStatusEnum.ACTIVE,
          integrations: { has: sourceName },
        },
        deleted: null,
      },
      include: { action: true },
    });

    // TODO (actons): Send all integration accounts based on the ask
    await Promise.all(
      actionEntities.map(async (actionEntity: ActionEntity) => {
        await this.actionsQueue.run({
          slug: actionEntity.action.slug,
          workspaceId,
          actionId: actionEntity.action.id,
          event: ActionTypesEnum.SOURCE_WEBHOOK,
          payload: {
            eventBody,
            eventHeaders,
            ...(await prepareTriggerPayload(
              this.prisma,
              this.integrations,
              actionEntity.action.id,
            )),
          },
        });
      }),
    );

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
   * its purpose. A queue that cannot be reached must not stop the actions that
   * the same webhook triggers.
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
