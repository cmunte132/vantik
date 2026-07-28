import {
  IntegrationEventPayload,
  IntegrationPayloadEventType,
} from '@vantikhq/types';

import { spec } from './spec';

/**
 * The local repository integration.
 *
 * This integration has no OAuth flow and no webhook, so this function answers
 * the specification event and nothing else. The routes under `local_repo` do
 * the work, because a person adds a directory and the server has no third
 * party to call.
 */
export default async function run(eventPayload: IntegrationEventPayload) {
  switch (eventPayload.event) {
    case IntegrationPayloadEventType.SPEC:
      return spec();

    default:
      return {
        message: `The event payload type is ${eventPayload.event}`,
      };
  }
}
