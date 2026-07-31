import { AGENT_RUN_DEFAULT_LIMITS } from '@vantikhq/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The stated ceiling has to be the enforced one.
 *
 * The runner in `packages/cli` owns the real numbers — it is what stops a run —
 * and declares them itself, because it is published on its own and does not
 * depend on the types package. So the constants exist twice, and this reads the
 * other one off disk.
 *
 * Worth a test rather than a comment for the same reason the Pi version is:
 * the delegation sheet quotes these numbers to somebody deciding whether to
 * spend them. A ceiling raised on one side leaves the app confidently telling
 * people a limit that is not the limit, and nothing else would notice.
 */
describe('the stated run ceiling', () => {
  it('matches the one the runner actually enforces', () => {
    const source = readFileSync(
      join(__dirname, '../../../../../packages/cli/src/runner/budget.ts'),
      'utf8',
    );

    const numberOf = (field: string) =>
      Number(
        new RegExp(`${field}: (\\d+(?:\\.\\d+)?),`).exec(source)?.[1] ?? NaN,
      );

    expect(numberOf('maxIterations')).toBe(
      AGENT_RUN_DEFAULT_LIMITS.maxIterations,
    );
    expect(numberOf('maxCostUsd')).toBe(AGENT_RUN_DEFAULT_LIMITS.maxCostUsd);
  });
});
