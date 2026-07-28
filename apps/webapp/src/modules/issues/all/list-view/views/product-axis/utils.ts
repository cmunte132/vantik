import { sort } from 'fast-sort';

import type { IssueType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

import { getIssueRows } from '../../list-view-utils';

/**
 * How the list and the board group issues by the second axis.
 *
 * A module and a capability are two groups of the same kind, and they differ in
 * three details: the field of an issue that names the group, whether that field
 * holds a list, and what a drag writes. One description covers both, and the
 * views below it stay one set of files instead of two.
 */

/** The column of a board that holds the issues of no group. */
export const NO_GROUP = 'no-axis-group';

/** One column of a board, or one header of a list. */
export interface AxisGroup {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
}

export interface AxisGrouping {
  kind: 'module' | 'capability';
  /** The field of an issue that names the group. */
  property: 'moduleIds' | 'capabilityId';
  /** Whether that field holds a list of ids and not one id. */
  isArray: boolean;
  groups: AxisGroup[];
  /** The header over the issues that name no group. */
  emptyLabel: string;
  /** A name for the scroll position of this list. */
  listId: string;
}

/** This function reports whether one issue belongs to one group. */
export function issueInGroup(
  issue: IssueType,
  grouping: AxisGrouping,
  groupId: string,
): boolean {
  if (grouping.isArray) {
    return (issue.moduleIds ?? []).includes(groupId);
  }

  return issue.capabilityId === groupId;
}

/** This function reports whether one issue names no group at all. */
export function issueInNoGroup(
  issue: IssueType,
  grouping: AxisGrouping,
): boolean {
  if (grouping.isArray) {
    return (issue.moduleIds ?? []).length === 0;
  }

  return !issue.capabilityId;
}

/**
 * This function returns the modules of an issue after a drag on the board.
 *
 * A drag moves an issue out of one column and into another, so the module of
 * the first column goes and the module of the second arrives. The other modules
 * of the issue stay: a drag says where the issue now also belongs, and it says
 * nothing about the modules that no column showed.
 *
 * `from` and `to` are group ids, or `NO_GROUP` for the column of issues that
 * name no module.
 */
export function moduleIdsAfterDrag(
  current: string[],
  from: string,
  to: string,
): string[] {
  const kept = current.filter((moduleId) => moduleId !== from);

  if (to === NO_GROUP) {
    return kept;
  }

  return kept.includes(to) ? kept : [...kept, to];
}

/**
 * This hook returns the rows of the list, in order.
 *
 * The groups come out in the order of their names, because a module list is a
 * list a person reads and not a list a machine sorts.
 */
export const useAxisIssueRows = (
  issues: IssueType[],
  grouping: AxisGrouping,
) => {
  const {
    applicationStore: {
      displaySettings: { showEmptyGroups },
    },
    issuesStore,
    issueRelationsStore,
  } = useContextStore();

  return getIssueRows(
    issues,
    grouping.property,
    sort(grouping.groups)
      .asc((group) => group.name)
      .map((group) => group.id),
    showEmptyGroups,
    issuesStore,
    issueRelationsStore,
    grouping.isArray,
  );
};
