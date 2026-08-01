import {
  ActionTypesEnum,
  IntegrationEventPayload,
  IntegrationPayloadEventType,
} from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

import { integrationCreate } from './account-create';
import { getIdentifier } from './get-identifier';
import { getToken } from './get-token';
import { spec } from './spec';
import { emailTriage } from './triage';

export { emailSpec as pluginSpec } from './plugin-spec';

export default async function run(
  eventPayload: IntegrationEventPayload,
  ctx: PluginContext,
) {
  // The connection half speaks `IntegrationPayloadEventType`, the behaviour
  // half `ActionTypesEnum`. One vendor, one entry point.
  switch (eventPayload.event as string) {
    /**
     * This is used to identify to which integration account the webhook belongs to
     */
    case IntegrationPayloadEventType.GET_CONNECTED_ACCOUNT_ID:
      return await getIdentifier(ctx, eventPayload.data.eventBody);

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

    /**
     * An email arrived. Folded in from `actions/email`, where it sat because
     * integrations were moved out to trigger.dev in 2024 and only the half a
     * person waits on came back. See ENG-89.
     */
    case ActionTypesEnum.SOURCE_WEBHOOK as string:
      return await emailTriage(
        ctx,
        eventPayload.eventBody,
        eventPayload.integrationAccounts?.email,
        eventPayload.action,
      );

    default:
      return {
        message: `The event payload type is ${eventPayload.event}`,
      };
  }
}
