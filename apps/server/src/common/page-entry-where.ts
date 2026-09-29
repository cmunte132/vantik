import { PageEntryPolicy, type Prisma } from '@prisma/client';

/**
 * The entries whose page is live, and the loose entries, which are on no
 * page.
 *
 * A filter on the page relation, such as `page: { deleted: null }`, matches
 * no loose entry, because a loose entry has no page to match. Every reader
 * that means "entries still in use" uses this filter instead, so that a
 * loose fact is read, triaged and served like a fact on a page.
 *
 * The filter uses `AND`, so that a caller can still give its own `OR`.
 */
export function onLivePageOrLoose(): Prisma.PageEntryWhereInput {
  return {
    AND: [{ OR: [{ pageId: null }, { page: { deleted: null } }] }],
  };
}

/** The entries of one workspace that are on a live page, or on no page. */
export function liveEntryIn(workspaceId: string): Prisma.PageEntryWhereInput {
  return { workspaceId, ...onLivePageOrLoose() };
}

/**
 * The entries on a live page that people do not keep by hand, and the loose
 * entries. A write that changes a fact another writer asserted uses this
 * filter, because a LOCKED page is maintained only by a person, and a loose
 * fact has no page to lock.
 */
export function onUnlockedPageOrLoose(): Prisma.PageEntryWhereInput {
  return {
    AND: [
      {
        OR: [
          { pageId: null },
          {
            page: {
              deleted: null,
              entryPolicy: { not: PageEntryPolicy.LOCKED },
            },
          },
        ],
      },
    ],
  };
}

/**
 * Says where a fact is filed, for text that a person reads: "on the page
 * "Deployment"", or "outside any page" for a loose fact.
 */
export function entryPlace(page: { title: string } | null): string {
  return page ? `on the page "${page.title}"` : 'outside any page';
}
