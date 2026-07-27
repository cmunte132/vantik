import { PI_VERSION } from '@vantikhq/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two runners must pin the same Pi.
 *
 * The BYO runner in `packages/cli` declares the pinned version itself, because
 * it is published on its own and does not depend on the types package —
 * importing it for a version string would pull the whole server-side type
 * surface into that bundle. So the constant exists twice, and this reads the
 * other one off disk.
 *
 * Worth a test rather than a comment: the whole reason the version is pinned
 * and recorded is that two runs of an issue are only comparable when you know
 * what drove them. Two runners silently on different builds defeats that, and
 * nothing else in the system would notice.
 */
describe('the pinned Pi version', () => {
  it('matches the one the BYO runner pins', () => {
    const source = readFileSync(
      join(__dirname, '../../../../../packages/cli/src/runner/pi-harness.ts'),
      'utf8',
    );

    const declared = /export const PI_VERSION = '([^']+)'/.exec(source)?.[1];

    expect(declared).toBeDefined();
    expect(declared).toBe(PI_VERSION);
  });
});
