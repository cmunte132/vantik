import { task } from '@trigger.dev/sdk/v3';
import { ActionEventPayload } from '@vantikhq/types';

import { emailHandler } from './handlers/email-handler';
import { vantikHandler } from './handlers/vantik-handler';

export async function run(eventPayload: ActionEventPayload) {
  const [vantikResponse] = await Promise.all([
    vantikHandler(eventPayload),
    emailHandler(eventPayload),
  ]);
  return { vantikResponse };
}

export const notificationHandler = task({ id: 'notification', run });
