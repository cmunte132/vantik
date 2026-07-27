/**
 * The ceilings.
 *
 * Tested directly because every failure they prevent is one that costs money
 * silently: a run that spirals still "works", it just bills for it, and the
 * wall clock catches it only after the whole budget is gone.
 */
import { BUDGET_DEFAULTS, breach, newSpend, type Spend } from './budget';

function spending(overrides: Partial<Spend> = {}): Spend {
  return { ...newSpend(), ...overrides };
}

describe('breach', () => {
  it('lets an ordinary run alone', () => {
    expect(
      breach(spending({ iterations: 12, costUsd: 0.4, tokens: 90_000 }), {}),
    ).toBeNull();
  });

  it('stops a run that has taken too many turns', () => {
    const reason = breach(
      spending({ iterations: BUDGET_DEFAULTS.maxIterations }),
      {},
    );

    expect(reason).toContain('turns');
  });

  it('stops a run that has spent too much', () => {
    const reason = breach(spending({ costUsd: 5.01 }), {});

    expect(reason).toContain('$5.01');
  });

  it('stops a model that is talking rather than working', () => {
    // The spiral the iteration and cost caps only catch after paying for it.
    const reason = breach(
      spending({ idleTurns: BUDGET_DEFAULTS.maxIdleTurns }),
      {},
    );

    expect(reason).toContain('without using a tool');
  });

  it('stops retrying a provider that keeps failing', () => {
    const reason = breach(
      spending({ consecutiveRetries: BUDGET_DEFAULTS.maxConsecutiveRetries }),
      {},
    );

    expect(reason).toContain('provider');
  });

  it('honours a run that asked for a tighter ceiling than the default', () => {
    expect(breach(spending({ iterations: 3 }), { maxIterations: 3 })).toContain(
      'turns',
    );
    expect(breach(spending({ costUsd: 0.5 }), { maxCostUsd: 0.5 })).toContain(
      '$0.50',
    );
  });

  it('caps a run even when nobody configured anything', () => {
    // The important one. `limits` arrives as `{}` on every run today, and an
    // agent with a shell, a model and no ceiling is an open-ended bill.
    expect(breach(spending({ iterations: 999 }), {})).not.toBeNull();
    expect(breach(spending({ costUsd: 1000 }), {})).not.toBeNull();
  });

  it('leaves tokens uncapped unless a run asks, since cost is the better proxy', () => {
    expect(breach(spending({ tokens: 50_000_000 }), {})).toBeNull();
    expect(
      breach(spending({ tokens: 50_000 }), { maxTokens: 50_000 }),
    ).toContain('tokens');
  });
});
