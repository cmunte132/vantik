/**
 * Which issue a call of a personal session belongs to.
 *
 * A root session can work on several issues in turn, and it can start child
 * sessions. Each call takes the issue that was current when it was written, so
 * a call that comes in late still belongs to the issue it was made for.
 */

/** A linked issue of one root session, and when the session was linked to it. */
export interface LinkedIssue {
  id: string;
  key: string;
  createdAt: Date;
}

/** A pickup or an issue write, once the task it names is resolved. */
export interface Transition {
  at: Date;
  /** The linked issue it moved the work to, or null when it names none. */
  issueId: string | null;
}

/**
 * The linked issue that a task reference names: its key (case-insensitive), or
 * its id. A task that is not linked to the session names no issue, so it cannot
 * receive allocation.
 */
export function resolveTaskRef(
  taskRef: string,
  links: LinkedIssue[],
): string | null {
  const ref = taskRef.trim();
  const upper = ref.toUpperCase();
  const match = links.find(
    (link) => link.id === ref || link.key.toUpperCase() === upper,
  );
  return match?.id ?? null;
}

/**
 * The transition that a pickup or an issue write makes, or null when it makes
 * none. An explicit pickup always moves the work, to no issue when the task is
 * not linked: that is the intended unattributed case. An issue write to an
 * unlinked task names no issue of this session, so it does not move the work.
 * It stays an audit fact in the record. Both the new batch and the stored
 * transitions use this rule, so they cannot disagree.
 */
export function transitionOf(
  at: Date,
  tool: 'pickup' | 'write',
  taskRef: string,
  links: LinkedIssue[],
): Transition | null {
  const issueId = resolveTaskRef(taskRef, links);
  if (tool === 'write' && issueId === null) {
    return null;
  }
  return { at, issueId };
}

/**
 * The issue that a call written at `at` belongs to.
 *
 * The latest transition strictly before the call decides. A call in the same
 * entry as its pickup is still on the earlier issue. Before any transition, the
 * call belongs to the latest link created by then. A call before every link
 * belongs to no issue, so the person's own work before it stays unattributed.
 */
export function issueAt(
  at: Date,
  transitions: Transition[],
  links: LinkedIssue[],
): string | null {
  let latest: Transition | null = null;
  for (const transition of transitions) {
    if (transition.at < at && (!latest || transition.at >= latest.at)) {
      latest = transition;
    }
  }
  if (latest) {
    return latest.issueId;
  }

  let link: LinkedIssue | null = null;
  for (const candidate of links) {
    if (
      candidate.createdAt <= at &&
      (!link || candidate.createdAt > link.createdAt)
    ) {
      link = candidate;
    }
  }
  return link?.id ?? null;
}

/** The key that a billing mode and cost basis share in a billing summary. */
export function billingKey(billingMode: string, costBasis: string): string {
  return `${billingMode}/${costBasis}`;
}
