import {
  ActionTypesEnum,
  IntegrationEventPayload,
  IntegrationPayloadEventType,
} from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

import { integrationCreate } from './account-create';
import { getToken } from './get-token';
import { isActionSupportedEvent } from './is_action_supported_event';
import { discordMessage } from './message';
import { spec } from './spec';
export { discordSpec as pluginSpec } from './spec-plugin';

export default async function run(
  eventPayload: IntegrationEventPayload,
  ctx: PluginContext,
) {
  // The event is one of two enums now: the connection half speaks
  // `IntegrationPayloadEventType`, the behaviour half `ActionTypesEnum`.
  // One vendor, one entry point, so the switch takes both.
  switch (eventPayload.event as string) {
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

    /**
     * The behaviour half, folded in from `actions/discord`.
     *
     * It lived in a separate bundle because integrations were moved out to
     * trigger.dev in 2024 and only the half a person waits on came back. Both
     * halves are one vendor and now one directory. See ENG-89.
     */
    case ActionTypesEnum.SOURCE_WEBHOOK as string: {
      const eventBody = eventPayload.eventBody as Record<string, unknown>;
      const discordEvent = eventBody?.t;

      switch (discordEvent) {
        case 'MESSAGE_CREATE':
          return await discordMessage(ctx, eventBody);

        default:
          ctx.log.debug(`Unhandled Discord event ${discordEvent}`);

          return { message: `Unhandled Discord event ${discordEvent}` };
      }
    }

    default:
      return {
        message: `The event payload type is ${eventPayload.event}`,
      };
  }
}
