import { GroupingEnum } from 'store/application';

/**
 * Which view each grouping uses.
 *
 * The name of a view lives here, and the component of that name lives in
 * `list-view.tsx`. The split is what lets a test read this mapping: a component
 * of this app reaches the whole app through its imports, down to the font that
 * the page loads, and a test cannot import one.
 *
 * Both halves are a `Record` with a closed key, so the compiler refuses a
 * grouping with no view and a view with no component. That is the guard that
 * was missing: `GroupingEnum` carried `module` and `capability` while the
 * dispatch was a chain of ifs, so choosing either one grouped the list by
 * status and reported nothing.
 */
export type GroupingViewName =
  | 'assignee'
  | 'priority'
  | 'label'
  | 'project'
  | 'team'
  | 'module'
  | 'capability'
  | 'status';

export const VIEW_NAME_FOR_GROUPING: Record<GroupingEnum, GroupingViewName> = {
  [GroupingEnum.assignee]: 'assignee',
  [GroupingEnum.priority]: 'priority',
  [GroupingEnum.label]: 'label',
  [GroupingEnum.project]: 'project',
  [GroupingEnum.team]: 'team',
  [GroupingEnum.module]: 'module',
  [GroupingEnum.capability]: 'capability',
  [GroupingEnum.status]: 'status',
};

/** The view of a grouping that this version does not know. */
export const DEFAULT_VIEW_NAME: GroupingViewName = 'status';

/**
 * This function returns the name of the view for one grouping.
 *
 * A display setting outlives the code that wrote it. A person who chose a
 * grouping that a later version removed still has the name of it in the store,
 * so an unknown name falls back rather than renders nothing.
 */
export function viewNameForGrouping(grouping: string): GroupingViewName {
  return VIEW_NAME_FOR_GROUPING[grouping as GroupingEnum] ?? DEFAULT_VIEW_NAME;
}
