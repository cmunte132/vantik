/** What a run's model calls have cost, and how many turns they took. */
export interface Spend {
  costUsd: number;
  turns: number;
}

/**
 * Keeps a run's spend on the run while it works.
 *
 * Pi reports the cost of each message as it settles, and the event reader sees
 * it at once. Writing every one of those to the run would be a database write
 * and a sync to every client for each message, so the meter writes at most once
 * per interval. A trailing write is scheduled for the last change in an
 * interval, so a value is never left stale behind a long quiet command.
 *
 * The run's spend is the sum of the invocations that have ended, plus what the
 * one in flight has reported so far. `settle` moves an invocation from the
 * second to the first and writes at once.
 *
 * A write never fails the run. The spend on the run is for a person to watch;
 * the run's final result is written from `total` when it ends either way.
 */
export class SpendMeter {
  private settled: Spend = { costUsd: 0, turns: 0 };
  private current: Spend = { costUsd: 0, turns: 0 };
  private written: Spend = { costUsd: 0, turns: 0 };
  private lastWriteAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly write: (spend: Spend) => Promise<unknown>,
    private readonly everyMs = 3000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Everything spent so far, including the invocation in flight. */
  get total(): Spend {
    return {
      costUsd: this.settled.costUsd + this.current.costUsd,
      turns: this.settled.turns + this.current.turns,
    };
  }

  /** What the invocation in flight has spent so far. */
  progress(spend: Spend): void {
    this.current = spend;

    if (this.stopped || !this.changed()) {
      return;
    }

    const wait = this.lastWriteAt + this.everyMs - this.now();

    if (wait <= 0) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, wait);
      this.timer.unref?.();
    }
  }

  /** The invocation in flight ended, having spent this in all. */
  settle(spend: Spend): Promise<void> {
    this.settled = {
      costUsd: this.settled.costUsd + spend.costUsd,
      turns: this.settled.turns + spend.turns,
    };
    this.current = { costUsd: 0, turns: 0 };

    return this.flush();
  }

  /** No more writes. The run's final result takes over from here. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Writes the total now, if it changed. In order, one at a time. */
  private flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;

    if (this.stopped || !this.changed()) {
      return this.chain;
    }

    const spend = this.total;
    this.written = spend;
    this.lastWriteAt = this.now();

    // A write that throws, as well as one that rejects, is swallowed here.
    this.chain = this.chain
      .then(() => this.write(spend))
      .then(
        (): undefined => undefined,
        (): undefined => undefined,
      );

    return this.chain;
  }

  private changed(): boolean {
    const total = this.total;

    return (
      total.costUsd !== this.written.costUsd ||
      total.turns !== this.written.turns
    );
  }
}
