import { type Spend, SpendMeter } from './spend-meter';

describe('SpendMeter', () => {
  let now: number;
  let writes: Spend[];
  let meter: SpendMeter;

  beforeEach(() => {
    jest.useFakeTimers();
    now = 10_000;
    writes = [];
    meter = new SpendMeter(
      async (spend) => {
        writes.push(spend);
      },
      3000,
      () => now,
    );
  });

  afterEach(() => {
    meter.stop();
    jest.useRealTimers();
  });

  it('writes the first spend at once', async () => {
    meter.progress({ costUsd: 0.01, turns: 1 });
    await Promise.resolve();

    expect(writes).toEqual([{ costUsd: 0.01, turns: 1 }]);
  });

  it('writes at most once per interval, and the last value at its end', async () => {
    meter.progress({ costUsd: 0.01, turns: 1 });
    now += 1000;
    meter.progress({ costUsd: 0.02, turns: 2 });
    now += 1000;
    meter.progress({ costUsd: 0.03, turns: 3 });
    await Promise.resolve();

    expect(writes).toHaveLength(1);

    // Nothing else arrives: the trailing write, scheduled at the second value
    // for the end of the interval, still lands. The value on the run is not
    // left stale behind a long command.
    now += 1000;
    await jest.advanceTimersByTimeAsync(2000);

    expect(writes).toEqual([
      { costUsd: 0.01, turns: 1 },
      { costUsd: 0.03, turns: 3 },
    ]);
  });

  it('adds each settled invocation to the ones before it', async () => {
    meter.progress({ costUsd: 0.05, turns: 4 });
    await meter.settle({ costUsd: 0.06, turns: 5 });
    meter.progress({ costUsd: 0.01, turns: 1 });

    expect(meter.total.costUsd).toBeCloseTo(0.07);
    expect(meter.total.turns).toBe(6);
    expect(writes[writes.length - 1]).toEqual({ costUsd: 0.06, turns: 5 });
  });

  it('writes nothing when nothing changed', async () => {
    await meter.settle({ costUsd: 0, turns: 0 });

    expect(writes).toEqual([]);
  });

  it('writes nothing once stopped', async () => {
    meter.progress({ costUsd: 0.01, turns: 1 });
    meter.stop();
    now += 5000;
    meter.progress({ costUsd: 0.02, turns: 2 });
    await jest.advanceTimersByTimeAsync(5000);

    expect(writes).toEqual([{ costUsd: 0.01, turns: 1 }]);
  });

  it('survives a write that fails', async () => {
    const failing = new SpendMeter(
      () => Promise.reject(new Error('gone')),
      3000,
      () => now,
    );

    await expect(
      failing.settle({ costUsd: 0.01, turns: 1 }),
    ).resolves.toBeUndefined();
    failing.stop();
  });
});
