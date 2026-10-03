import type { HarnessCall } from './pi-events';
import type { MeteredModelCall } from '@vantikhq/types';

export interface ReconciledSpend {
  /** What the run's calls cost, as billed wherever the provider said. */
  costUsd: number;
  /** What the harness priced the same calls at, from its catalog. */
  catalogCostUsd: number;
  /** Calls whose cost came from the provider rather than the catalog. */
  billedCalls: number;
  /**
   * Metered calls the harness never settled a message for (a cut-off stream,
   * a request it retried), whose billed cost is added in.
   */
  unmatchedBilledCalls: number;
}

/**
 * The spend of one harness command: each call at the provider's billed cost
 * when the sandbox host metered one for it, else at the harness's price.
 *
 * Calls are joined on the provider's response id, which the harness keeps on
 * its message and the meter reads from the response. A metered call nothing
 * joins to still costs what the provider billed for it, so it is added; one
 * with no billed cost (a direct provider) is left out, since the harness
 * prices every call it saw and a call it did not see has no price here.
 */
export function reconcileSpend(
  harness: readonly HarnessCall[],
  metered: readonly MeteredModelCall[],
): ReconciledSpend {
  const byId = new Map<string, MeteredModelCall>();
  for (const call of metered) {
    if (call.responseId) {
      byId.set(call.responseId, call);
    }
  }

  const joined = new Set<string>();
  let costUsd = 0;
  let catalogCostUsd = 0;
  let billedCalls = 0;

  for (const call of harness) {
    catalogCostUsd += call.costUsd;
    const match = call.responseId ? byId.get(call.responseId) : undefined;

    if (match?.responseId) {
      joined.add(match.responseId);
    }
    if (match?.costUsd !== undefined) {
      costUsd += match.costUsd;
      billedCalls += 1;
    } else {
      costUsd += call.costUsd;
    }
  }

  let unmatchedBilledCalls = 0;
  for (const call of metered) {
    if (call.costUsd === undefined) {
      continue;
    }
    if (call.responseId && joined.has(call.responseId)) {
      continue;
    }
    costUsd += call.costUsd;
    unmatchedBilledCalls += 1;
  }

  return { costUsd, catalogCostUsd, billedCalls, unmatchedBilledCalls };
}
