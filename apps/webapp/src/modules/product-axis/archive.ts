/**
 * What it means to archive a product, a module or a capability.
 *
 * All three carry a free `status` string, so archive is a status and not a new
 * column. `archived` is the one value that the app itself reads; every other
 * value is a word that a person chose, such as `planned` or `live`.
 *
 * Archive is not delete. A delete removes the thing and the server refuses one
 * that would leave a module without an owner. An archive says the work stopped:
 * the row keeps its issues and its history, and its page stays readable. It
 * leaves the places where a person picks something to work on, because those
 * lists are about what to do next.
 */

export const ARCHIVED_STATUS = 'archived';

/** The status that a row of this kind returns to when a person restores it. */
const DEFAULT_STATUS = {
  product: 'active',
  module: 'active',
  // A capability that nobody has built yet is planned, and that is where a
  // restored one belongs: it names no work in progress.
  capability: 'planned',
};

export type AxisKind = keyof typeof DEFAULT_STATUS;

/** Anything that carries a status. */
export interface HasStatus {
  status?: string | null;
}

/** This function reports whether a person archived this row. */
export function isArchived(item: HasStatus | null | undefined): boolean {
  return item?.status === ARCHIVED_STATUS;
}

/**
 * This function returns the rows that a person can still pick.
 *
 * Every list that offers a choice uses it: the sidebar, the grouping views, and
 * the pickers on an issue. A list that reports what exists does not, because an
 * archived row still exists.
 */
export function withoutArchived<Item extends HasStatus>(items: Item[]): Item[] {
  return items.filter((item) => !isArchived(item));
}

/**
 * This function returns the status that an archive or a restore writes.
 *
 * A restore cannot return the row to the status it held before, because nothing
 * records that. It returns the ordinary status of a row of this kind, which a
 * person then changes if they want another one.
 */
export function statusAfterArchive(kind: AxisKind, archive: boolean): string {
  return archive ? ARCHIVED_STATUS : DEFAULT_STATUS[kind];
}
