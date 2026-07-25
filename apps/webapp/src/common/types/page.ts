/** How strictly a page polices entries appended to it by agents. */
export enum PageEntryPolicy {
  OPEN = 'OPEN',
  CURATED = 'CURATED',
  LOCKED = 'LOCKED',
}

export enum PageEntryStatus {
  /** Awaiting review. The inbox — served to nobody. */
  PROPOSED = 'PROPOSED',
  /** Accepted and currently being served to agents. */
  STANDING = 'STANDING',
  /** Folded into the page body; no longer served on its own. */
  CONSOLIDATED = 'CONSOLIDATED',
  /** Replaced by a newer entry. Kept for audit. */
  SUPERSEDED = 'SUPERSEDED',
  /** Contradicts the body or another entry; withheld until resolved. */
  DISPUTED = 'DISPUTED',
  /** Aged out — never triaged, or never read. */
  ARCHIVED = 'ARCHIVED',
}

export interface PageType {
  id: string;
  createdAt: string;
  updatedAt: string;

  title: string;
  /** Tiptap JSON, the same shape the issue editor writes. */
  description?: string | null;
  parentId?: string | null;
  sortOrder?: number | null;

  /**
   * One of PageEntryPolicy. Typed as a string because the synced MobX model
   * declares `types.string`, the way every other synced enum in this app does;
   * comparisons against the enum still work since its members are strings.
   */
  entryPolicy: string;
  visibility: string;

  workspaceId: string;
  createdById?: string | null;
  updatedById?: string | null;
}

export interface PageEntryType {
  id: string;
  createdAt: string;
  updatedAt: string;

  content: string;
  scope?: string | null;
  /** One of PageEntryStatus. String for the same reason entryPolicy is. */
  status: string;

  /**
   * Who asserted it. An agent-written claim and a human-written one are
   * identical as text, which is the whole reason a reviewer is looking — so the
   * rail resolves this against the workspace's users and badges it.
   */
  sourceUserId?: string | null;
  sourceSession?: string | null;

  verifiedByUserId?: string | null;
  verifiedAt?: string | null;

  /** How often this has actually been served. Dead knowledge shows as zero. */
  retrievalCount: number;
  lastServedAt?: string | null;

  supersedesId?: string | null;
  pageId: string;
}

/** Counts the review rail opens on, before it renders a single row. */
export interface PageEntryFacets {
  total: number;
  status: Record<string, number>;
  sourceUserId: Record<string, number>;
  scope: Record<string, number>;
}

export interface KnowledgeGapType {
  query: string;
  count: number;
  lastAskedAt: string;
}
