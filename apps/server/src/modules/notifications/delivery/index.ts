import { type PrismaClient } from '@prisma/client';
import { ActionEventPayload } from '@vantikhq/types';

import { emailHandler } from './handlers/email-handler';
import { vantikHandler } from './handlers/vantik-handler';

/**
 * Delivers one notification event to both places a person might see it.
 *
 * The two handlers run together rather than in sequence because neither needs
 * the other's answer.
 *
 * Email failure does not sink the in-app notification, which is the one
 * behavioural change from the trigger.dev version and is deliberate.
 * `Promise.all` rejects as soon as either half does, so an unreachable SMTP
 * host lost the inbox row as well — the worse of the two outcomes, and the one
 * a person actually notices. Under trigger.dev that was survivable because the
 * whole task was retried; here a throw would retry both halves and write the
 * row a second time.
 *
 * The in-app half still throws, because that one failing means the job did not
 * do its job and should be retried.
 */
export async function deliverNotification(
  prisma: PrismaClient,
  payload: ActionEventPayload,
) {
  const [inApp, email] = await Promise.allSettled([
    vantikHandler(prisma, payload),
    emailHandler(prisma, payload),
  ]);

  if (inApp.status === 'rejected') {
    throw inApp.reason;
  }

  return {
    vantikResponse: inApp.value,
    emailDelivered: email.status === 'fulfilled',
    emailError:
      email.status === 'rejected' ? String(email.reason) : (undefined as never),
  };
}
