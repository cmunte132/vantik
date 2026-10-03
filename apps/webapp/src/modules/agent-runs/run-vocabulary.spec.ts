import { describe, expect, it } from 'vitest';

import { FAILURE_PROSE, failureProse, shownStatus } from './run-vocabulary';

describe('a refused call in words', () => {
  it.each([
    ['402: This request requires more credits', 'out of credit'],
    ['401: Missing Authentication header', 'rejected the key'],
    ['403: Forbidden', 'rejected the key'],
    ['429: rate limited', 'rate-limiting'],
    ['404: No endpoints found for this model', 'does not know this model'],
  ])('tells a person what to do about %s', (error, remedy) => {
    expect(failureProse({ failure: 'MODEL_REFUSED', error })?.next).toContain(
      remedy,
    );
  });

  it('falls back to the general remedy for a status it has none for', () => {
    expect(
      failureProse({ failure: 'MODEL_REFUSED', error: '500: oops' }),
    ).toEqual(FAILURE_PROSE.MODEL_REFUSED);
  });

  it('leaves every other failure as it was', () => {
    expect(
      failureProse({ failure: 'HARNESS_CRASHED', error: '402: x' }),
    ).toEqual(FAILURE_PROSE.HARNESS_CRASHED);
    expect(failureProse({ failure: null })).toBeUndefined();
  });
});

describe('shownStatus', () => {
  const cleanedUp = { at: '2026-10-03T18:17:10Z', pullRequest: 'closed' };

  it('calls a cleaned-up run awaiting review rejected', () => {
    expect(shownStatus({ status: 'NEEDS_REVIEW', result: { cleanedUp } })).toBe(
      'REJECTED',
    );
  });

  it('leaves every other run its own status', () => {
    expect(shownStatus({ status: 'NEEDS_REVIEW', result: {} })).toBe(
      'NEEDS_REVIEW',
    );
    expect(shownStatus({ status: 'FAILED', result: { cleanedUp } })).toBe(
      'FAILED',
    );
    expect(shownStatus({ status: 'NEEDS_REVIEW', result: null })).toBe(
      'NEEDS_REVIEW',
    );
  });
});
