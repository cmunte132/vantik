/**
 * What the Pages home and a product's page list show: what the workspace
 * knows, how far each page's facts can be trusted, and what agents could
 * not find out.
 *
 * The server computes this in one read, because each part comes from rows
 * that the synced store does not hold: trust comes from citation checks,
 * use comes from `PageEntryUse`, and a page's product comes from its links
 * and the modules of its facts.
 */

/** How many facts in use rest on each kind of evidence. */
export interface KnowledgeFactCounts {
  /** Facts in use: standing, or folded into a page body. */
  inUse: number;
  /** In use, and every cited line of code still holds. */
  code: number;
  /** In use, and a person confirmed it. */
  people: number;
  /** In use, and it rests on an outside page that the server read. */
  observed: number;
  /** In use, with no evidence that still holds. */
  unconfirmed: number;
  /** Waiting on a person: an entry to decide, an audit, or a rewrite. */
  needYou: number;
}

export interface KnowledgeOverviewPage {
  id: string;
  title: string;
  parentId: string | null;
  /** AUTHORED or GENERATED. */
  kind: string;
  /** The first paragraph of the body, cut short. Null for an empty page. */
  summary: string | null;
  updatedAt: string;
  /**
   * The product the page is about. A PRODUCT link decides it. Otherwise the
   * modules of its other links and of its facts vote, and a sub-page takes
   * its parent's product when it has none of its own.
   */
  productId: string | null;
  facts: KnowledgeFactCounts;
  /** A gardener rewrite of the body waits on a person. */
  rewriteWaiting: boolean;
  /** A fact the body was written from no longer holds. */
  outOfDate: boolean;
  /** How often agents were given the page's facts in the last 30 days. */
  given30d: number;
}

export interface KnowledgeOverviewProduct {
  id: string;
  name: string;
}

/** A question agents asked more than once that nothing answered. */
export interface KnowledgeOverviewGap {
  id: string;
  query: string;
  count: number;
  lastAskedAt: string;
}

/** A gap an agent is working on now, through the gap's issue. */
export interface KnowledgeOverviewResearch {
  gapId: string;
  query: string;
  runId: string;
  /** The run's latest event, for example "Reading kroger/cart.ts". */
  activity: string | null;
  startedAt: string;
}

export interface KnowledgeOverviewWeek {
  /** Facts that agents wrote in the last 7 days. */
  written: number;
  /**
   * Of those, the facts triage accepted without a person. When triage runs
   * in shadow, the facts it would have accepted.
   */
  settled: number;
  /** Of `settled`, the facts that rest on an outside page. */
  settledObserved: number;
  /** Gaps an accepted fact answered in the last 7 days. */
  gapsClosed: number;
}

export interface KnowledgeOverview {
  /** off, shadow or on. */
  autoTriage: string;
  facts: KnowledgeFactCounts;
  week: KnowledgeOverviewWeek;
  /** When the gardener last did anything in the workspace. */
  gardenerAt: string | null;
  pages: KnowledgeOverviewPage[];
  products: KnowledgeOverviewProduct[];
  gaps: KnowledgeOverviewGap[];
  research: KnowledgeOverviewResearch[];
}
