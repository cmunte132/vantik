import { ActionEventPayload } from '@vantikhq/types';
import { task } from '@trigger.dev/sdk/v3';

import { emailHandler } from './handlers/email-handler';
import { slackHandler } from './handlers/slack-handler';
import { vantikHandler } from './handlers/vantik-handler';

export async function run(eventPayload: ActionEventPayload) {
  const [slackResponse, vantikResponse] = await Promise.all([
    slackHandler(eventPayload),
    vantikHandler(eventPayload),
    emailHandler(eventPayload),
  ]);
  return { slackResponse, vantikResponse };
}

export const notificationHandler = task({ id: 'notification', run });
