import type { HarnessLimits } from './contract';

/**
 * The ceilings a run is held to, and the defaults when nobody sets one.
 *
 * An agent with a shell, a model and no ceiling is an open-ended bill. The
 * wall clock alone is not a guardrail: it is a blunt one that lets a run spend
 * its entire budget spiralling and then reports that it ran out of time, which
 * tells the reader nothing about why.
 *
 * These are deliberately generous — they are there to catch a run that has
 * gone wrong, not to shape one that is going right. A run that trips one of
 * them was almost certainly not about to succeed.
 */
export const BUDGET_DEFAULTS = {
  /**
   * Assistant turns. Enough for a real piece of work with a verification loop;
   * far short of an afternoon.
   */
  maxIterations: 50,
  /**
   * Dollars, summed from the usage the provider reports. The cap that matters,
   * because it is the one denominated in the thing being spent.
   */
  maxCostUsd: 5,
  /**
   * Turns in a row that call no tool at all.
   *
   * The signature of a model talking to itself: it keeps producing prose,
   * never touches the repository, and every turn costs money. Nothing else
   * catches this — the iteration and cost caps eventually will, but only after
   * paying for the whole spiral.
   */
  maxIdleTurns: 5,
  /**
   * Provider retries in a row with no turn in between. A model endpoint that
   * is failing will fail again; retrying it until the wall clock runs out
   * turns an outage into a wasted budget.
   */
  maxConsecutiveRetries: 5,
} as const;

export interface Spend {
  iterations: number;
  tokens: number;
  costUsd: number;
  /** Turns since the last tool call. */
  idleTurns: number;
  /** Retries since the last completed turn. */
  consecutiveRetries: number;
}

export function newSpend(): Spend {
  return {
    iterations: 0,
    tokens: 0,
    costUsd: 0,
    idleTurns: 0,
    consecutiveRetries: 0,
  };
}

/**
 * This function returns why a run must stop, or null.
 *
 * The reason is prose rather than a code because it is read by whoever has to
 * decide what to do about it, and "it stopped" is not a finding. Each one says
 * which ceiling was reached and what the run had spent when it got there.
 */
export function breach(spend: Spend, limits: HarnessLimits): string | null {
  const maxIterations = limits.maxIterations ?? BUDGET_DEFAULTS.maxIterations;
  const maxCostUsd = limits.maxCostUsd ?? BUDGET_DEFAULTS.maxCostUsd;

  if (spend.iterations >= maxIterations) {
    return `The agent took ${spend.iterations} turns, which is the limit. A run that needs more than this is usually working on an issue that should have been split.`;
  }

  if (spend.costUsd >= maxCostUsd) {
    return `The run had spent $${spend.costUsd.toFixed(2)}, which is the limit.`;
  }

  if (limits.maxTokens && spend.tokens >= limits.maxTokens) {
    return `The run had used ${spend.tokens} tokens, which is the limit.`;
  }

  if (spend.idleTurns >= BUDGET_DEFAULTS.maxIdleTurns) {
    return `The agent took ${spend.idleTurns} turns in a row without using a tool. It is talking rather than working, and every turn costs money.`;
  }

  if (spend.consecutiveRetries >= BUDGET_DEFAULTS.maxConsecutiveRetries) {
    return `The model call failed ${spend.consecutiveRetries} times in a row. That is the provider, not the work.`;
  }

  return null;
}
