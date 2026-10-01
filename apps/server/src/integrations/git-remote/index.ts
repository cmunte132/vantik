import {
  IntegrationEventPayload,
  IntegrationPayloadEventType,
} from '@vantikhq/types';

import { spec } from './spec';

/**
 * The git remote integration.
 *
 * This integration has no OAuth flow and no webhook, so this function answers
 * the specification event and nothing else. The routes under `git_remote` do
 * the work. A person gives the address of a host and a token, so there is no
 * OAuth flow to run.
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
