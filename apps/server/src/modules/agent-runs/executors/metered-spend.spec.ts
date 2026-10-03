import type { MeteredModelCall } from '@vantikhq/types';

import { reconcileSpend } from './metered-spend';

const metered = (call: Partial<MeteredModelCall>): MeteredModelCall => ({
  seq: 0,
  host: 'openrouter.ai',
  api: 'openai-chat',
  status: 200,
  startedAt: 0,
  durationMs: 1,
  ...call,
});

describe('reconcileSpend', () => {
  it('counts each call at the billed cost where the provider gave one', () => {
    const spend = reconcileSpend(
      [
        { responseId: 'gen-1', costUsd: 0.01 },
        { responseId: 'gen-2', costUsd: 0.02 },
        { costUsd: 0.03 },
      ],
      [
        metered({ responseId: 'gen-1', costUsd: 0.015 }),
        // A direct provider sends no cost: the catalog price stands.
        metered({ responseId: 'gen-2' }),
      ],
    );

    expect(spend.costUsd).toBeCloseTo(0.015 + 0.02 + 0.03, 9);
    expect(spend.catalogCostUsd).toBeCloseTo(0.06, 9);
    expect(spend.billedCalls).toBe(1);
    expect(spend.unmatchedBilledCalls).toBe(0);
  });

  it('adds a billed call the harness never settled a message for', () => {
    const spend = reconcileSpend(
      [{ responseId: 'gen-1', costUsd: 0.01 }],
      [
        metered({ responseId: 'gen-1', costUsd: 0.01 }),
        metered({ responseId: 'gen-cut', costUsd: 0.004 }),
        // A refused request: no id, no cost, nothing to add.
        metered({ status: 429 }),
      ],
    );

    expect(spend.costUsd).toBeCloseTo(0.014, 9);
    expect(spend.unmatchedBilledCalls).toBe(1);
  });

  it('is the harness figure when nothing was metered', () => {
    expect(reconcileSpend([{ costUsd: 0.2 }], [])).toEqual({
      costUsd: 0.2,
      catalogCostUsd: 0.2,
      billedCalls: 0,
      unmatchedBilledCalls: 0,
    });
  });
});
