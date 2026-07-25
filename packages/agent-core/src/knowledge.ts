/**
 * The knowledge-bank half of the agent surface.
 *
 * Named the way an agent thinks about it — a page is referred to by title, a
 * fact is "remembered", context is "loaded" — rather than mirroring the API's
 * rows. Same rule as `types.ts`: no uuids in, no editor JSON out.
 *
 * Neutral, like the rest of agent-core. The mechanical limits (entry policy,
 * the per-token budget on untriaged entries) live on the server and apply to
 * every caller; the opinion about *when* an agent should append rather than
 * write a new page lives only in the MCP tool layer.
 */

export type EntryStatus =
  | 'PROPOSED'
  | 'STANDING'
  | 'CONSOLIDATED'
  | 'SUPERSEDED'
  | 'DISPUTED'
  | 'ARCHIVED';

export type EntryPolicy = 'OPEN' | 'CURATED' | 'LOCKED';

export interface KnowledgePageRef {
  id: string;
  title: string;
}

export interface KnowledgePage extends KnowledgePageRef {
  /** Markdown. Nobody reading a page should have to parse editor JSON. */
  body: string;
  parentId: string | null;
  entryPolicy: EntryPolicy;
  /** Root first, so a reader can see where the page sits. */
  ancestors: KnowledgePageRef[];
  /** Facts currently being served for this page. */
  standing: KnowledgeEntry[];
  /**
   * When the page last changed. This is the revision a file on disk records, so
   * a push can tell "nothing moved" from "somebody else edited this while I had
   * it checked out".
   */
  updatedAt: string;
}

export interface KnowledgeEntry {
  id: string;
  content: string;
  /** Repo path glob, team or project this applies to; null is page-level. */
  scope: string | null;
  status: EntryStatus;
  /** Who asserted it, and in which harness run. */
  sourceUserId: string | null;
  sourceSession: string | null;
  /** Whether a human has confirmed it. */
  verified: boolean;
  /** How often it has actually been served — demonstrated usefulness. */
  retrievalCount: number;
  supersedesId: string | null;
  pageId: string;
  createdAt: string;
}

export interface KnowledgeHit {
  /** Agreed narrative from a page body, or one agent's asserted fact. */
  kind: 'page' | 'entry';
  page: KnowledgePageRef;
  entryId: string | null;
  content: string;
  scope: string | null;
  verified: boolean;
  retrievalCount: number;
  score?: number;
}

export interface ContextPack {
  items: KnowledgeHit[];
  estimatedTokens: number;
  tokenBudget: number;
  /** Matched but did not fit. Stated rather than silently dropped. */
  omitted: number;
}

export interface RecallInput {
  query: string;
  /** Narrow to facts asserted about this repo path, team or project. */
  scope?: string;
  limit?: number;
}

export interface LoadContextInput {
  /** What the caller is about to do. Free text; used as the question. */
  task?: string;
  scope?: string;
  /** How much context the caller can afford, in tokens. */
  tokenBudget?: number;
}

export interface RememberInput {
  /** Page title or id. The fact is appended to this page. */
  page: string;
  /** One self-contained claim, in markdown. */
  content: string;
  scope?: string;
  /** Harness session id, so the claim can be traced back to a run. */
  session?: string;
  /** The entry this one replaces. Flips that entry to SUPERSEDED. */
  supersedes?: string;
  /**
   * Confirms the caller has looked at the near matches and considers this fact
   * distinct.
   *
   * Without it, a write with near matches comes back as `needs-decision`
   * carrying them, rather than appending. This is a two-phase write, not a
   * judgment: nothing is ever rejected on a similarity threshold, because
   * measured against a real index cosine distance did not reliably rank an
   * exact restatement above an unrelated document. A model comparing two short
   * facts does that far better — so it gets shown the candidates and decides.
   */
  distinct?: boolean;
}

export type RememberResult =
  | { status: 'written'; entry: KnowledgeEntry }
  | {
      status: 'needs-decision';
      nearMatches: KnowledgeHit[];
      /** What to do next, in words the caller can act on. */
      guidance: string;
    };

export interface WritePageInput {
  /** Title of the page to create, or of the one to rewrite. */
  title: string;
  /** Markdown body. */
  body?: string;
  /** Parent page title or id, to nest it. */
  parent?: string;
  entryPolicy?: EntryPolicy;
}

export interface ConsolidateInput {
  page: string;
  /** The rewritten body, in markdown. */
  body: string;
  /** Entries folded in. Omit to fold every standing entry on the page. */
  entryIds?: string[];
}

export interface TriageInput {
  entryIds: string[];
  status: EntryStatus;
}

export interface KnowledgeGap {
  query: string;
  count: number;
  lastAskedAt: string;
}
