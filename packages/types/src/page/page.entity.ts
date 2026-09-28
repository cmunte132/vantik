import { Workspace } from '../workspace';
import type { KnowledgeProof } from './citation';

/**
 * How strictly a page polices appended entries.
 *
 * The control has to be mechanical rather than advisory. The failure mode is
 * not one badly-behaved agent; it is ten well-behaved ones each appending the
 * same six facts, because rediscovering those facts is what a memory bank
 * exists to prevent.
 */
export enum PageEntryPolicyEnum {
  /** Append freely — scratch pages, where volume does not matter. */
  OPEN = 'OPEN',
  /** Dedup and the per-token budget are enforced. The default. */
  CURATED = 'CURATED',
  /** Human-only: agents read the page but cannot append to it. */
  LOCKED = 'LOCKED',
}

export enum PageEntryStatusEnum {
  /** Awaiting triage. An inbox — never served. */
  PROPOSED = 'PROPOSED',
  /** True, too granular for prose, worth retrieving. The only served status. */
  STANDING = 'STANDING',
  /** Folded into the page body; serving it again would duplicate the fact. */
  CONSOLIDATED = 'CONSOLIDATED',
  /** Replaced by a newer entry. Kept for audit, never served. */
  SUPERSEDED = 'SUPERSEDED',
  /** Contradicts the body or another entry; withheld until resolved. */
  DISPUTED = 'DISPUTED',
  /** Aged out — either never triaged or never read. */
  ARCHIVED = 'ARCHIVED',
}

export enum PageVisibilityEnum {
  WORKSPACE = 'WORKSPACE',
}

/**
 * Who writes a page's body. People write an AUTHORED page, and an agent can
 * only propose a change to it. The gardener builds a GENERATED page from the
 * entries each of its sections cites, and edits it as those entries change.
 */
export enum PageKindEnum {
  AUTHORED = 'AUTHORED',
  GENERATED = 'GENERATED',
}

/** Where a proposed change to a page body stands. */
export enum PageProposalStateEnum {
  OPEN = 'OPEN',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
}

/**
 * One section of a generated page. The id is stable: a refresh names the
 * sections it replaces or removes by it, and every other section is kept
 * exactly as it was. `entryIds` are the entries it was written from.
 */
export interface PageSection {
  id: string;
  heading: string;
  /** Markdown. */
  body: string;
  entryIds: string[];
}

/**
 * What a page can be linked to.
 *
 * Nesting gives a page one parent, which cannot say "this runbook belongs to
 * the Payments project and the Platform team". Links can, and unlike a mention
 * buried in prose they are traversable in both directions.
 */
export enum PageLinkTypeEnum {
  TEAM = 'TEAM',
  PROJECT = 'PROJECT',
  ISSUE = 'ISSUE',
  PAGE = 'PAGE',
  PRODUCT = 'PRODUCT',
  MODULE = 'MODULE',
  CAPABILITY = 'CAPABILITY',
}

/**
 * What sort of knowledge an entry is. The guidance already asks for decisions,
 * gotchas and conventions; recording which lets a reader ask for just the
 * conventions of a module.
 */
export enum PageEntryKindEnum {
  /** Something true about the system. The default. */
  FACT = 'FACT',
  /** A choice that was made, and why. */
  DECISION = 'DECISION',
  /** How things are done here: a rule a newcomer would not guess. */
  CONVENTION = 'CONVENTION',
  /** Something that cost somebody time. */
  GOTCHA = 'GOTCHA',
}

export class Page {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  title: string;
  /** Tiptap JSON. The API speaks markdown on both sides of this field. */
  description: string | null;

  parentId: string | null;
  sortOrder: number | null;

  entryPolicy: PageEntryPolicyEnum;
  visibility: PageVisibilityEnum;

  kind: PageKindEnum;
  /** The question a generated page answers. */
  question: string | null;
  /** A generated page's body as sections; null for an authored page. */
  sections: PageSection[] | null;
  /** The entries the page cites, which stay in use as its evidence. */
  citedEntryIds: string[];
  /** For a generated page: the newest change in its evidence at the last build. */
  watermark: Date | null;
  /** For a generated page: a hash of what its evidence said at the last build. */
  evidenceHash: string | null;
  /** For a generated page: when it was last built. */
  refreshedAt: Date | null;

  workspace?: Workspace;
  workspaceId: string;

  createdById: string | null;
  updatedById: string | null;
}

/**
 * A change to a page body waiting on a person: an agent's consolidation into
 * a page people maintain. The body is markdown here, as every page body the
 * API returns is.
 */
export interface PageProposal {
  id: string;
  createdAt: string;
  pageId: string;
  pageTitle: string;
  bodyMarkdown: string;
  /** The entries it folds in, which the page cites once it is accepted. */
  entryIds: string[];
  proposedById: string | null;
  state: PageProposalStateEnum;
  decidedById: string | null;
  decidedAt: string | null;
}

export class PageEntry {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  /** Markdown, short. One claim per row. */
  content: string;
  /** Repo path glob, team or project the fact applies to; null is page-level. */
  scope: string | null;
  /** The modules the scope resolves to, kept by the server. */
  moduleIds: string[];

  kind: PageEntryKindEnum;

  status: PageEntryStatusEnum;

  sourceUserId: string | null;
  sourceSession: string | null;
  sourceTokenId: string | null;

  supersedesId: string | null;

  verifiedByUserId: string | null;
  verifiedAt: Date | null;

  retrievalCount: number;
  lastServedAt: Date | null;

  page?: Page;
  pageId: string;

  /**
   * The proof, when the entry is served: trust tier, citations, and the last
   * check of them. Derived by the server on the way out, never stored.
   */
  trust?: KnowledgeProof['trust'];
  citations?: KnowledgeProof['citations'];
  lastCheckedAt?: KnowledgeProof['lastCheckedAt'];
  lastCheckedSha?: KnowledgeProof['lastCheckedSha'];
}

export class PageHistory {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  userId: string | null;
  pageId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changes: Record<string, any> | null;
  previousBody: string | null;
}
