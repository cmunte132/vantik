import { ActionEventPayload } from '@vantikhq/types';

import { deliverNotification } from './delivery';
import { emailHandler } from './delivery/handlers/email-handler';
import { vantikHandler } from './delivery/handlers/vantik-handler';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsQueue } from './notifications.queue';

jest.mock('./delivery/handlers/vantik-handler', () => ({
  vantikHandler: jest.fn(),
}));
jest.mock('./delivery/handlers/email-handler', () => ({
  emailHandler: jest.fn(),
}));

const inApp = vantikHandler as jest.Mock;
const email = emailHandler as jest.Mock;

const payload = {
  event: 'ON_CREATE',
  notificationData: { issueId: 'issue-1' },
} as unknown as ActionEventPayload;

/**
 * Notification delivery, after moving off trigger.dev.
 *
 * The reason this file exists is not the move itself but what the move had to
 * decide: which half of a delivery is allowed to fail without losing the other.
 * Under trigger.dev the whole task was retried, so `Promise.all` rejecting was
 * survivable. On a Bull queue a throw retries both halves, so an SMTP outage
 * would have written the inbox row again on every attempt.
 */
describe('delivering one notification', () => {
  beforeEach(() => {
    inApp.mockReset();
    email.mockReset();
  });

  it('delivers to the inbox and to email', async () => {
    inApp.mockResolvedValue({ message: 'created notifications' });
    email.mockResolvedValue(undefined);

    await expect(deliverNotification({} as never, payload)).resolves.toEqual({
      vantikResponse: { message: 'created notifications' },
      emailDelivered: true,
      emailError: undefined,
    });
  });

  /**
   * The behaviour that changed, and the reason for `allSettled`. A deployment
   * with no working SMTP is ordinary — the in-app inbox is the half a person
   * sees in the product, and it must not depend on a mail host.
   */
  it('still writes the inbox row when email fails', async () => {
    inApp.mockResolvedValue({ message: 'created notifications' });
    email.mockRejectedValue(new Error('ECONNREFUSED smtp'));

    const result = await deliverNotification({} as never, payload);

    expect(result.vantikResponse).toEqual({ message: 'created notifications' });
    expect(result.emailDelivered).toBe(false);
    expect(result.emailError).toContain('ECONNREFUSED');
  });

  /**
   * The other half is not optional. If the row was not written there is nothing
   * to see anywhere, so the job has to fail and be retried.
   */
  it('fails when the inbox row cannot be written', async () => {
    inApp.mockRejectedValue(new Error('deadlock detected'));
    email.mockResolvedValue(undefined);

    await expect(deliverNotification({} as never, payload)).rejects.toThrow(
      'deadlock detected',
    );
  });

  it('does not let a failing email hide a failing inbox row', async () => {
    inApp.mockRejectedValue(new Error('deadlock detected'));
    email.mockRejectedValue(new Error('ECONNREFUSED smtp'));

    await expect(deliverNotification({} as never, payload)).rejects.toThrow(
      'deadlock detected',
    );
  });
});

describe('enqueueing a notification', () => {
  it('asks for retries rather than a single attempt', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const queue = new NotificationsQueue({ add } as never);

    await queue.deliver(payload);

    expect(add).toHaveBeenCalledTimes(1);
    const [job, data, options] = add.mock.calls[0];
    expect(job).toBe('deliverNotification');
    expect(data).toEqual({ payload });
    expect(options.attempts).toBeGreaterThan(1);
    // Kept, and bounded. A queue that discards failures looks identical to one
    // with nothing wrong, which is the state this whole change came out of.
    expect(options.removeOnFail).toBeGreaterThan(0);
  });

  /**
   * Enqueueing must not be able to fail the request that caused it. Creating an
   * issue should not 500 because redis blinked — that is the same mistake as
   * the old arrangement, in the other direction.
   */
  it('does not fail the caller when the queue is unreachable', async () => {
    const add = jest.fn().mockRejectedValue(new Error('redis is down'));
    const queue = new NotificationsQueue({ add } as never);

    await expect(queue.deliver(payload)).resolves.toBeUndefined();
  });
});

describe('the processor', () => {
  beforeEach(() => {
    inApp.mockReset();
    email.mockReset();
  });

  it('rethrows so Bull records the failure and retries', async () => {
    inApp.mockRejectedValue(new Error('deadlock detected'));
    email.mockResolvedValue(undefined);

    const processor = new NotificationsProcessor({} as never);

    await expect(
      processor.handleDeliverNotification({ data: { payload } } as never),
    ).rejects.toThrow('deadlock detected');
  });

  /** An unreachable mail host is not a job failure. */
  it('treats an email-only failure as success', async () => {
    inApp.mockResolvedValue({ message: 'created notifications' });
    email.mockRejectedValue(new Error('ECONNREFUSED smtp'));

    const processor = new NotificationsProcessor({} as never);

    const result = await processor.handleDeliverNotification({
      data: { payload },
    } as never);

    expect(result.emailDelivered).toBe(false);
  });
});
