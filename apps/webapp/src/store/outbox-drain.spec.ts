import { describe, expect, it } from 'vitest';

import { isRetryable } from './outbox-drain';

/**
 * What separates "the network was in the way" from "the server said no".
 *
 * Retrying the first is the entire point of the buffer. Retrying the second is
 * a loop with someone's edit stuck inside it: a rejected field or a permission
 * failure will be rejected identically on every attempt, forever, and the user
 * will never be told because the write still looks pending.
 */
describe('isRetryable', () => {
  it('retries a request that never reached a server', () => {
    // No status at all is what a dropped connection looks like from here.
    expect(isRetryable({})).toBe(true);
    expect(isRetryable({ status: 0 })).toBe(true);
  });

  it('retries a server that admits the fault is its own', () => {
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 502 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it('retries when the server asks for the same request later', () => {
    expect(isRetryable({ status: 408 })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
  });

  it('gives up on an answer that will not change', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it('reads the status out of the wrapped error shape too', () => {
    // The ajax layer surfaces some failures as `errors.statusCode` rather than
    // `status`; missing that would queue a rejected write forever.
    expect(isRetryable({ errors: { statusCode: 400 } })).toBe(false);
    expect(isRetryable({ errors: { statusCode: 503 } })).toBe(true);
  });
});
