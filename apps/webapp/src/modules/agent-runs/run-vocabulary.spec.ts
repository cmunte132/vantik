import { describe, expect, it } from 'vitest';

import { FAILURE_PROSE, failureProse } from './run-vocabulary';

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
