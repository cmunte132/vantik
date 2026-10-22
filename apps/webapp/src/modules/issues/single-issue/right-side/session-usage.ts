/**
 * The usage of an agent session, as `GET agent_sessions/:id/usage` returns it,
 * and how to show it. Nothing here is cash: every amount is an estimate of what
 * the calls would cost at list or metered prices. Billing routes stay apart,
 * and a call with no known amount is counted, never summed as $0.
 */

export interface BillingBucket {
  costUsd: number;
  pricedCalls: number;
  unpricedCalls: number;
}

export type BillingSummary = Record<string, BillingBucket>;

export interface SessionUsage {
  issue: {
    ledger: {
      costUsd: number;
      turns: number;
      unknownCalls: number;
      byBilling: BillingSummary;
    };
    /** What the issue held before usage was recorded. Unverified. */
    legacy: {
      costUsd: number;
      turns: number;
      unknownCalls: number;
      unverified: true;
    } | null;
  };
  /** The whole session. Null when the viewer may not see it. */
  canonical: {
    knownCostUsd: number;
    unattributedCostUsd: number;
    unknownCallCount: number;
    byBilling: BillingSummary;
    coverage: { mainCalls: number; childSessions: number; childCalls: number };
    legacyUnverified: boolean;
  } | null;
}

export interface UsageLine {
  label: string;
  /** A formatted amount, or a plain word when the amount is not summed. */
  amount: string;
  note?: string;
}

/** The billing routes, in the order they are shown. Each one is summed alone. */
const ROUTES: Array<{ mode: string; label: string; note: string }> = [
  {
    mode: 'subscription',
    label: 'Subscription API-equivalent estimate',
    note: 'List-price valuation, not a provider bill or a quota measurement.',
  },
  {
    mode: 'metered',
    label: 'Metered route estimate',
    note: 'Recorded estimate, not reconciled against provider billing.',
  },
  {
    mode: 'unknown',
    label: 'Route not recorded',
    note: 'Estimate only. Not added to the other routes.',
  },
];

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

/** The buckets of one billing mode, summed. Modes are kept apart by the caller. */
function sumMode(byBilling: BillingSummary, mode: string): BillingBucket {
  const total: BillingBucket = { costUsd: 0, pricedCalls: 0, unpricedCalls: 0 };
  for (const [key, bucket] of Object.entries(byBilling)) {
    if (key.split('/')[0] !== mode) {
      continue;
    }
    total.costUsd += bucket.costUsd;
    total.pricedCalls += bucket.pricedCalls;
    total.unpricedCalls += bucket.unpricedCalls;
  }
  return total;
}

function routeLines(byBilling: BillingSummary): UsageLine[] {
  const lines: UsageLine[] = [];
  for (const route of ROUTES) {
    const total = sumMode(byBilling, route.mode);
    if (total.pricedCalls > 0) {
      lines.push({
        label: route.label,
        amount: formatUsd(total.costUsd),
        note: route.note,
      });
    }
  }
  return lines;
}

function unpricedCount(byBilling: BillingSummary): number {
  return Object.values(byBilling).reduce(
    (sum, bucket) => sum + bucket.unpricedCalls,
    0,
  );
}

/** The lines for this issue's own share. */
export function issueUsageLines(usage: SessionUsage): UsageLine[] {
  const { ledger, legacy } = usage.issue;
  const lines = routeLines(ledger.byBilling);
  const unpriced = unpricedCount(ledger.byBilling);
  if (unpriced > 0) {
    lines.push({
      label: 'Calls with no known amount',
      amount: 'not summed',
      note: `${unpriced} ${unpriced === 1 ? 'call' : 'calls'}, counted and left out of every total.`,
    });
  }
  if (legacy) {
    lines.push({
      label: 'Recorded before usage tracking',
      amount: formatUsd(legacy.costUsd),
      note: 'Unverified. Not reconciled, and not in the figures above.',
    });
  }
  return lines;
}

/**
 * The lines for the whole session. A viewer who may not see it gets one line
 * that says so, and no amounts.
 */
export function sessionUsageLines(usage: SessionUsage): UsageLine[] {
  const canonical = usage.canonical;
  if (!canonical) {
    return [
      {
        label: 'Whole session',
        amount: 'not shown',
        note: 'Whole-session details are unavailable or private.',
      },
    ];
  }
  const lines = routeLines(canonical.byBilling);
  if (canonical.unattributedCostUsd > 0) {
    lines.push({
      label: 'Not attributed to an issue',
      amount: formatUsd(canonical.unattributedCostUsd),
      note: 'Recorded work without a resolved issue assignment.',
    });
  }
  const unpriced = unpricedCount(canonical.byBilling);
  if (unpriced > 0) {
    lines.push({
      label: 'Calls with no known amount',
      amount: 'not summed',
      note: `${unpriced} ${unpriced === 1 ? 'call' : 'calls'} across the session.`,
    });
  }
  if (canonical.legacyUnverified) {
    lines.push({
      label: 'Earlier totals remain unverified',
      amount: 'kept separate',
      note: 'Historical amounts are not part of the new ledger.',
    });
  }
  return lines;
}
