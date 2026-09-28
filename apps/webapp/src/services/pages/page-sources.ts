/**
 * What a generated page's sections were written from.
 *
 * The body of a generated page is a model's prose; each section cites the
 * entries it rests on, and this is how the page view shows them beside it,
 * each with its trust tier, and says which are no longer in use.
 */

/** One section as the server stores it, without the body the editor shows. */
export interface PageSectionRef {
  id: string;
  heading: string;
  entryIds: string[];
}

/** An entry a section cites, as the entry list serves it. */
export interface CitedEntry {
  id: string;
  content: string;
  status: string;
  /** HUMAN_VERIFIED, GROUNDED or UNGROUNDED. */
  trust?: string | null;
}

export interface SectionSources {
  id: string;
  heading: string;
  /** Every id the section cites; `entry` is null once it is out of use. */
  sources: Array<{ id: string; entry: CitedEntry | null }>;
}

/**
 * The request for the entries a page cites that are still in use, with
 * their proof, or null when it cites none.
 */
export function citedEntriesUrl(entryIds: string[]): string | null {
  const ids = [...new Set(entryIds)].sort();

  if (ids.length === 0) {
    return null;
  }

  const params = new URLSearchParams({
    ids: ids.join(','),
    status: 'STANDING,CONSOLIDATED',
  });

  return `/api/v1/page_entries?${params}`;
}

/** The sections a page stores, or none: the column is JSON, and not trusted. */
export function readSectionRefs(stored: unknown): PageSectionRef[] {
  if (!Array.isArray(stored)) {
    return [];
  }

  return stored.flatMap((section) =>
    section &&
    typeof section.id === 'string' &&
    typeof section.heading === 'string' &&
    Array.isArray(section.entryIds)
      ? [
          {
            id: section.id,
            heading: section.heading,
            entryIds: section.entryIds.filter(
              (id: unknown): id is string => typeof id === 'string',
            ),
          },
        ]
      : [],
  );
}

/** Each section with the entries it cites, in the order it cites them. */
export function sectionSources(
  sections: PageSectionRef[],
  entries: CitedEntry[],
): SectionSources[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  return sections.map((section) => ({
    id: section.id,
    heading: section.heading,
    sources: section.entryIds.map((id) => ({
      id,
      entry: byId.get(id) ?? null,
    })),
  }));
}
