import { Workspace } from '../workspace';

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
}

/** Statuses retrieval is allowed to serve. Everything else is withheld. */
export const SERVED_ENTRY_STATUSES: PageEntryStatusEnum[] = [
  PageEntryStatusEnum.STANDING,
];

/** Statuses an entry can never move out of once it lands there. */
export const TERMINAL_ENTRY_STATUSES: PageEntryStatusEnum[] = [
  PageEntryStatusEnum.CONSOLIDATED,
  PageEntryStatusEnum.SUPERSEDED,
];

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

  workspace?: Workspace;
  workspaceId: string;

  createdById: string | null;
  updatedById: string | null;
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
}
