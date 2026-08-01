import {
  IntegrationEventPayload,
  IntegrationPayloadEventType,
} from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

import { integrationCreate } from './account-create';
import { getToken } from './get-token';
import { isActionSupportedEvent } from './is_action_supported_event';
import { spec } from './spec';

export default async function run(
  eventPayload: IntegrationEventPayload,
  ctx: PluginContext,
) {
  switch (eventPayload.event) {
    /**
     * This is used to identify to which integration account the webhook belongs to
     */
    case IntegrationPayloadEventType.GET_CONNECTED_ACCOUNT_ID:
      return eventPayload.data.eventBody.d.guild_id;

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

    case IntegrationPayloadEventType.GET_TOKEN:
      return await getToken(ctx, eventPayload.integrationAccountId);

    case IntegrationPayloadEventType.IS_ACTION_SUPPORTED_EVENT:
      return isActionSupportedEvent(eventPayload.eventBody);

    default:
      return {
        message: `The event payload type is ${eventPayload.event}`,
      };
  }
}
