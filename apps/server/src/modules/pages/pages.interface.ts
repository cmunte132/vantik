import { PageEntryStatusEnum } from '@vantikhq/types';

/**
 * The mechanical limits on writing to the knowledge bank.
 *
 * These are *not* the curation opinion. That lives in the MCP tool layer, which
 * is the only surface allowed to editorialise — the CLI and the REST API stay
 * neutral, exactly as they do for issues. What lives here is arithmetic: how
 * many untriaged claims one token may leave on one page, and how long unread
 * knowledge sits before it stops being anyone's problem.
 *
 * The reason they are server-side is that a tool description asking for
 * restraint is advisory. It fails precisely when a cheaper or unfamiliar model
 * is pointed at the endpoint, which is the cross-harness case the bank exists
 * to serve.
 */

/**
 * Untriaged entries one token may leave on one curated page.
 *
 * Per token rather than per account: an account can hold several tokens, and a
 * budget spent per account would let one noisy harness exhaust the allowance of
 * every other harness signed in as the same agent.
 */
export const PROPOSED_ENTRY_BUDGET = Number(
  process.env.PAGE_PROPOSED_ENTRY_BUDGET ?? 10,
);

/**
 * How long an untriaged entry waits before it archives itself.
 *
 * An unbounded inbox is what actually overwhelms a person: fifty rows nobody
 * will ever read is the same as no review surface at all.
 */
export const PROPOSED_ENTRY_EXPIRY_DAYS = Number(
  process.env.PAGE_PROPOSED_ENTRY_EXPIRY_DAYS ?? 30,
);

/**
 * How long a standing entry may go unserved before it archives itself. Unused
 * knowledge is by definition not load-bearing.
 */
export const STANDING_ENTRY_DECAY_DAYS = Number(
  process.env.PAGE_STANDING_ENTRY_DECAY_DAYS ?? 90,
);

/**
 * Transitions a client may ask for.
 *
 * `CONSOLIDATED` and `SUPERSEDED` are absent as sources because they are
 * terminal: the first has been folded into the page body and the second has
 * been replaced, and reviving either puts a fact back into circulation that the
 * workspace already decided about. `PROPOSED` is absent as a *target* because
 * triage does not run backwards, and `SUPERSEDED` is absent as a target because
 * it is only ever set by the supersede path, which also records the pointer.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<
  PageEntryStatusEnum,
  PageEntryStatusEnum[]
> = {
  [PageEntryStatusEnum.PROPOSED]: [
    PageEntryStatusEnum.STANDING,
    PageEntryStatusEnum.DISPUTED,
    PageEntryStatusEnum.CONSOLIDATED,
    PageEntryStatusEnum.ARCHIVED,
  ],
  [PageEntryStatusEnum.STANDING]: [
    PageEntryStatusEnum.DISPUTED,
    PageEntryStatusEnum.CONSOLIDATED,
    PageEntryStatusEnum.ARCHIVED,
  ],
  [PageEntryStatusEnum.DISPUTED]: [
    PageEntryStatusEnum.STANDING,
    PageEntryStatusEnum.CONSOLIDATED,
    PageEntryStatusEnum.ARCHIVED,
  ],
  [PageEntryStatusEnum.ARCHIVED]: [
    PageEntryStatusEnum.STANDING,
    PageEntryStatusEnum.DISPUTED,
  ],
  [PageEntryStatusEnum.CONSOLIDATED]: [],
  [PageEntryStatusEnum.SUPERSEDED]: [],
};

/** A page with the counts the tree view needs, without loading every entry. */
export interface PageWithCounts {
  id: string;
  title: string;
  parentId: string | null;
  entryCounts: Record<string, number>;
}

/** Who is writing, resolved once at the controller boundary. */
export interface WriterIdentity {
  userId: string;
  /** Null for a browser session, which is not issued for any token. */
  tokenId: string | null;
}
