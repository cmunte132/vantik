import type { ReactNode } from 'react';

import type { IssueType } from 'common/types';

import type { UpdateIssueParams } from 'services/issues';

/**
 * How the list and the board group issues.
 *
 * Every grouping is the same few facts: the field of an issue that names its
 * group, whether that field holds a list, the groups in the order they are
 * shown, and the group of issues that name none. The list, the board and its
 * columns read those facts and nothing else, so there is one of each for all
 * eight groupings where there were eight of each, and each copy had drifted in
 * its own way.
 *
 * Nothing here renders, so the specs can import it. `groupings.tsx` builds each
 * grouping out of the stores.
 */

/** The fields of an issue that a view can group by. */
export type GroupedField =
  | 'stateId'
  | 'assigneeId'
  | 'labelIds'
  | 'priority'
  | 'projectId'
  | 'teamId'
  | 'moduleIds'
  | 'capabilityId';

type FieldValue = string | number;

/**
 * One value of the field that puts an issue in a group.
 *
 * A status or a label belongs to one team, and a view over several teams shows
 * the ones that share a name as one group. That group has one value per team,
 * and a drag has to write the one that belongs to the team of the issue.
 */
export interface GroupValue {
  value: FieldValue;
  /** The team whose issues can hold this value; absent or null for any team. */
  teamId?: string | null;
}

/** What a header shows: the list's header and the board's column alike. */
export interface GroupHeader {
  name: string;
  icon: ReactNode;
  /** The background of the header, for a group with a colour of its own. */
  color?: string;
}

/** One header of the list, and one column of the board. */
export interface Group extends GroupHeader {
  /** Unique within the grouping; the id of the board's column. */
  id: string;
  values: GroupValue[];
}

/** The group of the issues that name nothing. */
export interface EmptyGroup extends GroupHeader {
  /** What the field holds when it names nothing, and what a drag writes. */
  value: FieldValue | null;
}

export interface Grouping {
  field: GroupedField;
  /** Whether the field holds a list of values and not one. */
  isArray: boolean;
  /** In the order they are shown. */
  groups: Group[];
  /** Absent where every issue names a group: each has a status and a team. */
  empty?: EmptyGroup;
  /** Whether a drag between columns leaves the issue as it is. */
  readOnly?: boolean;
  /** A name for the scroll position of the list. */
  listId: string;
}

/** The column of the board, and the header of the list, of no group. */
export const NO_GROUP = 'no-group';

/**
 * The values an issue holds in the grouped field, as a list either way. The
 * value that stands for nothing is left out, so an issue that names nothing
 * holds an empty list: a priority of 0 is no priority, as null is.
 */
function heldValues(issue: IssueType, grouping: Grouping): FieldValue[] {
  const held = issue[grouping.field] as
    FieldValue | FieldValue[] | null | undefined;

  if (Array.isArray(held)) {
    return held;
  }

  return held == null || held === grouping.empty?.value ? [] : [held];
}

/**
 * This function sorts issues into their groups in one pass, keyed by group id
 * and by `NO_GROUP`, in the order the groups are shown.
 *
 * An issue sits in every group that one of its values names, and once in each:
 * an issue that changes two modules is work in two places. An issue whose value
 * names no group sits in none, which is what hides the issues of a status the
 * view leaves out.
 */
export function sortIntoGroups(
  issues: IssueType[],
  grouping: Grouping,
): Map<string, IssueType[]> {
  const sorted = new Map<string, IssueType[]>();
  const groupsOfValue = new Map<FieldValue, string[]>();

  for (const group of grouping.groups) {
    sorted.set(group.id, []);

    for (const { value } of group.values) {
      groupsOfValue.set(value, [...(groupsOfValue.get(value) ?? []), group.id]);
    }
  }

  if (grouping.empty) {
    sorted.set(NO_GROUP, []);
  }

  for (const issue of issues) {
    const held = heldValues(issue, grouping);

    if (held.length === 0) {
      sorted.get(NO_GROUP)?.push(issue);
      continue;
    }

    const groupIds = new Set(
      held.flatMap((value) => groupsOfValue.get(value) ?? []),
    );

    for (const groupId of groupIds) {
      sorted.get(groupId).push(issue);
    }
  }

  return sorted;
}

export type IssueRow =
  | { type: 'header'; key: string }
  | { type: 'issue'; issueId: string; hasRelations: boolean };

/** This function returns the rows of the list: a header, then its issues. */
export function getIssueRows(
  issues: IssueType[],
  grouping: Grouping,
  showEmptyGroups: boolean,
  hasRelations: (issue: IssueType) => boolean,
): IssueRow[] {
  const rows: IssueRow[] = [];

  for (const [key, grouped] of sortIntoGroups(issues, grouping)) {
    if (grouped.length === 0 && !showEmptyGroups) {
      continue;
    }

    rows.push({ type: 'header', key });

    for (const issue of grouped) {
      rows.push({
        type: 'issue',
        issueId: issue.id,
        hasRelations: hasRelations(issue),
      });
    }
  }

  return rows;
}

/** This function returns what the header of one group, or of none, shows. */
export function headerOf(
  grouping: Grouping,
  key: string,
): GroupHeader | undefined {
  if (key === NO_GROUP) {
    return grouping.empty;
  }

  return grouping.groups.find((group) => group.id === key);
}

/**
 * The value of a group that an issue can hold: the one of its own team, or one
 * that any team can hold. A label of one team is no label for another.
 */
function valueForIssue(group: Group, issue: IssueType) {
  return (
    group.values.find((candidate) => candidate.teamId === issue.teamId) ??
    group.values.find((candidate) => candidate.teamId == null)
  )?.value;
}

/**
 * This function returns what a drag from one column to another writes, or
 * undefined when it writes nothing.
 *
 * A list field loses the value of the first column and gains the value of the
 * second, and it keeps the values that no column of the drag showed: a drag
 * says where the issue now also belongs, and nothing about the rest. A single
 * field takes the value of the second column. The column of no group writes
 * the value that stands for nothing.
 *
 * `from` and `to` are group ids, or `NO_GROUP`.
 */
export function changeForDrop(
  issue: IssueType,
  grouping: Grouping,
  from: string,
  to: string,
): Partial<UpdateIssueParams> | undefined {
  if (from === to || grouping.readOnly) {
    return undefined;
  }

  const target =
    to === NO_GROUP
      ? undefined
      : grouping.groups.find((group) => group.id === to);

  if (to === NO_GROUP ? !grouping.empty : !target) {
    return undefined;
  }

  const incoming = target ? valueForIssue(target, issue) : undefined;

  // The team of the issue has no value of this name: a label that only another
  // team has, say. There is nothing it could hold.
  if (target && incoming === undefined) {
    return undefined;
  }

  if (grouping.isArray) {
    const current = heldValues(issue, grouping);
    const source = grouping.groups.find((group) => group.id === from);
    const kept = source
      ? current.filter(
          (value) => !source.values.some((left) => left.value === value),
        )
      : current;
    const next =
      incoming === undefined || kept.includes(incoming)
        ? kept
        : [...kept, incoming];

    const unchanged =
      next.length === current.length &&
      next.every((value) => current.includes(value));

    return unchanged ? undefined : { [grouping.field]: next };
  }

  const next = target ? incoming : grouping.empty.value;
  const current = issue[grouping.field] ?? grouping.empty?.value ?? null;

  return next === current ? undefined : { [grouping.field]: next };
}

/**
 * The id of a card on the board. One issue can sit in two columns, so the id
 * carries the column too; two cards with one id make the board refuse to draw.
 */
export function draggableIdFor(groupId: string, issueId: string) {
  return `${groupId}__${issueId}`;
}

/** This function returns the issue of a card's id. */
export function issueIdOfDraggable(draggableId: string) {
  return draggableId.split('__').pop();
}
