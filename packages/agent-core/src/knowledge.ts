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

/** AUTHORED: people write it. GENERATED: the server writes it from entries. */
export type PageKind = 'AUTHORED' | 'GENERATED';

/** One section of a generated page, and the entries it was written from. */
export interface KnowledgePageSection {
  id: string;
  heading: string;
  entryIds: string[];
}

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
  kind: PageKind;
  /** The question a generated page answers; null for one people write. */
  question: string | null;
  /** A generated page's sections, each with what it cites; empty otherwise. */
  sections: KnowledgePageSection[];
  /**
   * The entries the page cites that are still in use, with their proof: what
   * a generated page's sections, or a consolidated body, rest on. An id a
   * section cites that is missing here is no longer in use.
   */
  cited: KnowledgeEntry[];
  /**
   * When the page last changed. This is the revision a file on disk records, so
   * a push can tell "nothing moved" from "somebody else edited this while I had
   * it checked out".
   */
  updatedAt: string;
}

/**
 * How far an item of knowledge can be trusted. HUMAN_VERIFIED: a person
 * confirmed it. GROUNDED: accepted, and every citation it makes still reads
 * the same. UNGROUNDED: anything else. Null for a page body.
 */
export type KnowledgeTrust = 'HUMAN_VERIFIED' | 'GROUNDED' | 'UNGROUNDED';

/**
 * The last check of a citation. HOLDS: the cited lines read the same (or the
 * target exists). MOVED: they read the same elsewhere in the file. CHANGED:
 * they are gone from the file. MISSING: the file or target is gone. UNKNOWN:
 * the source could not be reached, so it has not been checked yet.
 */
export type CitationCheck =
  | 'HOLDS'
  | 'MOVED'
  | 'CHANGED'
  | 'MISSING'
  | 'UNKNOWN';

export type CitationKind =
  | 'CODE'
  | 'ISSUE'
  | 'PULL_REQUEST'
  | 'COMMENT'
  | 'RUN';

/**
 * What a claim rests on, as a writer names it: lines of code, or where a
 * decision was made. One citation names one thing.
 */
export type CitationInput =
  | {
      /** Relative to the repository root. */
      path: string;
      /** "40-52", or "40" for one line. */
      lines: string;
      /** The commit the lines are at. The default branch head when omitted. */
      sha?: string;
      /** owner/name, when the workspace has more than one repository. */
      repo?: string;
      /** Text that must be in the cited lines. Checked, never stored. */
      quote?: string;
    }
  /** An issue key such as ENG-42, or its id. */
  | { issue: string }
  /** A linked pull request's URL, or its link id. */
  | { pullRequest: string }
  /** An issue comment's id. */
  | { comment: string }
  /** An agent run's id. */
  | { run: string };

/** A citation as it is served, with its last check. */
export interface KnowledgeCitation {
  kind: CitationKind;
  /** CODE: the repository, path, commit and lines as last checked. */
  repo?: string | null;
  path?: string | null;
  commitSha?: string | null;
  lines?: string | null;
  /** Non-code: the issue key, pull request URL, or comment or run id. */
  target?: string | null;
  result: CitationCheck | null;
  checkedAt: string | null;
  checkedSha: string | null;
  /** CHANGED only: whether a judge model thinks the new code still agrees. */
  judgment?: 'HOLDS' | 'CONTRADICTED' | 'UNCLEAR' | null;
  judgeModel?: string | null;
}

/** What every served item of knowledge carries: how far to trust it, and why. */
export interface KnowledgeProof {
  trust: KnowledgeTrust | null;
  citations: KnowledgeCitation[];
  /** The latest check of any citation. */
  lastCheckedAt: string | null;
  /** The commit of the latest check of code; an issue or run has none. */
  lastCheckedSha: string | null;
}

export interface KnowledgeEntry extends KnowledgeProof {
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

/** What sort of knowledge an entry is. */
export type EntryKind = 'FACT' | 'DECISION' | 'CONVENTION' | 'GOTCHA';

export interface KnowledgeHit extends KnowledgeProof {
  /** Agreed narrative from a page body, or one agent's asserted fact. */
  kind: 'page' | 'entry';
  /** For an entry, what sort of knowledge it is. Null for a page body. */
  entryKind: EntryKind | null;
  page: KnowledgePageRef;
  entryId: string | null;
  content: string;
  scope: string | null;
  verified: boolean;
  retrievalCount: number;
  score?: number;
  /**
   * For an entry a page cites (a generated page's section, or a body it was
   * consolidated into), that page: the entry is the page's evidence, not a
   * second confirmation of what the page says. It comes after the page when
   * both match.
   */
  evidenceFor?: KnowledgePageRef | null;
}

export interface ContextPack {
  items: KnowledgeHit[];
  estimatedTokens: number;
  tokenBudget: number;
  /** Matched but did not fit. Stated rather than silently dropped. */
  omitted: number;
}

/**
 * Where a piece of work is in the product graph. Knowledge about these
 * modules, or the issue's modules and capability, ranks first, and knowledge
 * about their neighbours next.
 */
export interface KnowledgeSeeds {
  moduleIds?: string[];
  issueId?: string;
}

export interface RecallInput extends KnowledgeSeeds {
  query: string;
  /** Narrow to facts asserted about this repo path, team or project. */
  scope?: string;
  limit?: number;
  /** Only these kinds of entry. Page bodies drop out. */
  kinds?: EntryKind[];
  /** Harness session id, so what it is served is recorded against it. */
  session?: string;
}

export interface LoadContextInput extends KnowledgeSeeds {
  /** What the caller is about to do. Free text; used as the question. */
  task?: string;
  scope?: string;
  /** How much context the caller can afford, in tokens. */
  tokenBudget?: number;
  /** Harness session id, so what it is served is recorded against it. */
  session?: string;
}

/** What a page can be linked to. */
export type PageLinkType =
  | 'TEAM'
  | 'PROJECT'
  | 'ISSUE'
  | 'PAGE'
  | 'PRODUCT'
  | 'MODULE'
  | 'CAPABILITY';

export interface PageLink {
  id: string;
  pageId: string;
  entityType: PageLinkType;
  entityId: string;
  /**
   * An issue key and title, a project, team, product, module or capability
   * name, a page title.
   */
  label: string;
}

export interface LinkPageInput {
  /** Page title or id. */
  page: string;
  entityType: PageLinkType;
  /** The id of the team, project, issue, page, product, module or capability. */
  entityId: string;
}

/**
 * Pages reachable from one thing in the workspace.
 *
 * The traversal the graph exists for: an agent holding an issue can be handed
 * the documentation for it without knowing what the documentation is called,
 * which is the case free-text search is worst at.
 */
export interface PagesForInput {
  entityType: PageLinkType;
  entityId: string;
}

export interface RememberInput {
  /** Page title or id. The fact is appended to this page. */
  page: string;
  /** One self-contained claim, in markdown. */
  content: string;
  /** What sort of knowledge it is. FACT when omitted. */
  kind?: EntryKind;
  scope?: string;
  /** Harness session id, so the claim can be traced back to a run. */
  session?: string;
  /**
   * The entry this one replaces. It becomes SUPERSEDED when this one is
   * accepted, and is served until then.
   */
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
  /**
   * What the fact rests on. Every citation is checked before anything is
   * written, and one that does not hold refuses the write.
   */
  citations?: CitationInput[];
}

export type RememberResult =
  | { status: 'written'; entry: KnowledgeEntry }
  | {
      status: 'citation-failed';
      /** Which citation, counted from 1. */
      citation: number;
      /** What is wrong with it, in words the caller can act on. */
      message: string;
    }
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

/**
 * A consolidation proposed and waiting on a person. Nothing about the page or
 * its entries changes until a person accepts it; the entries then stay
 * served, as the evidence the body cites.
 */
export interface ConsolidateProposal {
  status: 'proposed';
  proposalId: string;
  page: KnowledgePageRef;
  /** The standing entries the body folds in. */
  entryIds: string[];
  /** What happens next. */
  guidance: string;
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
