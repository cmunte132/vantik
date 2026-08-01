import {
  IntegrationEventPayload,
  IntegrationPayloadEventType,
} from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

import { integrationCreate } from './account-create';
import { getToken } from './get-token';
import { codeChangeOf } from './pull-request';
import { spec } from './spec';

export default async function run(
  eventPayload: IntegrationEventPayload,
  ctx: PluginContext,
) {
  switch (eventPayload.event) {
    case IntegrationPayloadEventType.SPEC:
      return spec();

    // Used to save settings data
    case IntegrationPayloadEventType.CREATE:
      return await integrationCreate(
        ctx,
        eventPayload.userId,
        eventPayload.workspaceId,
        eventPayload.data,
      );

    case IntegrationPayloadEventType.GET_CONNECTED_ACCOUNT_ID:
      return eventPayload.data.eventBody.installation.id.toString();

    case IntegrationPayloadEventType.GET_TOKEN:
      return await getToken(ctx, eventPayload.integrationAccountId);

    // A pull request says which files it changes, and the server turns those
    // paths into modules. The bot token is the one that reads a private
    // repository of the installation.
    case IntegrationPayloadEventType.GET_CODE_CHANGE: {
      const { botToken } = await getToken(
        ctx,
        eventPayload.integrationAccountId,
      );

      return await codeChangeOf(eventPayload.eventBody, botToken);
    }

    case IntegrationPayloadEventType.IS_ACTION_SUPPORTED_EVENT:
      return true;

    default:
      return {
        message: `The event payload type is ${eventPayload.event}`,
      };
  }
}
