import { Injectable } from '@nestjs/common';
import { tasks } from '@trigger.dev/sdk/v3';
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
import { actionRun } from 'trigger/action-run';

import { prepareTriggerPayload } from 'modules/action-event/action-event.utils';
import { IntegrationsService } from 'modules/integrations/integrations.service';
import { LoggerService } from 'modules/logger/logger.service';
import { ModuleRoutingService } from 'modules/modules/module-routing.service';

@Injectable()
export default class WebhookService {
  private readonly logger: LoggerService = new LoggerService('WebhookService'); // Logger instance for logging

  constructor(
    private prisma: PrismaService,
    private integrations: IntegrationsService,
    private moduleRouting: ModuleRoutingService,
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
    actionEntities.map(async (actionEntity: ActionEntity) => {
      tasks.trigger<typeof actionRun>('action-run', {
        workspaceId,
        payload: {
          event: ActionTypesEnum.SOURCE_WEBHOOK,
          eventBody,
          eventHeaders,
          ...(await prepareTriggerPayload(
            this.prisma,
            this.integrations,
            actionEntity.action.id,
          )),
        },
      });
    });

    return { status: 200 };
  }

  /**
   * This method gives an issue the modules that a pull request changed.
   *
   * An integration that does not answer `GET_CODE_CHANGE`, and a webhook that
   * describes something other than a change to code, both give null here. That
   * is the ordinary case for most webhooks, and it is not a fault.
   *
   * The whole method is inside a try, because module routing is an addition to
   * a webhook and never its purpose. A repository that the server cannot read
   * must not stop the actions that the same webhook triggers.
   */
  private async routeCodeChange(
    sourceName: string,
    eventBody: EventBody,
    integrationAccountId: string,
    workspaceId: string,
  ) {
    try {
      const change = await this.integrations.loadIntegration(sourceName, {
        event: IntegrationPayloadEventType.GET_CODE_CHANGE,
        integrationAccountId,
        eventBody,
      });

      if (!change?.issueKeys?.length) {
        return;
      }

      await this.moduleRouting.routeCodeChange(change, workspaceId);
    } catch (error) {
      this.logger.error({
        message: `Could not route the code change of a ${sourceName} webhook`,
        where: 'WebhookService.routeCodeChange',
        error,
      });
    }
  }
}
