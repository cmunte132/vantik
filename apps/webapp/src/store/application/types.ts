/** A change to some of the filters; the ones not named keep their value. */
export type UpdateBody = Partial<FiltersModelType>;

export interface DisplaySettingsModelType {
  view: ViewEnum;
  grouping: GroupingEnum;
  ordering: OrderingEnum;
  completedFilter: TimeBasedFilterEnum;
  showSubIssues: boolean;
  showEmptyGroups: boolean;
}

export interface UpdateDisplaySettingsBody extends Partial<DisplaySettingsModelType> {}

export enum FilterTypeEnum {
  IS = 'IS',
  IS_NOT = 'IS_NOT',
  INCLUDES = 'INCLUDES',
  EXCLUDES = 'EXCLUDES',
  UNDEFINED = 'UNDEFINED',
}

export interface FilterModelType {
  value: string[];
  filterType: FilterTypeEnum;
}

export interface FilterModelBooleanType {
  filterType: FilterTypeEnum;
}

export interface FilterModelTimeBasedType {
  filterType: TimeBasedFilterEnum;
}

/**
 * Every filter an issue list can carry, in the order the filter menu shows them.
 *
 * A value filter holds the values somebody picked. A flag filter holds only
 * whether it is on. Adding a filter starts with its key here: the stored
 * model, the registry in `modules/issues/filters-view/filter-registry.ts` and
 * the components beside it are all keyed by these lists, so the compiler names
 * every place that still needs an entry.
 */
export const VALUE_FILTER_KEYS = [
  'status',
  'assignee',
  'label',
  'priority',
  'cycle',
  'project',
  'product',
  'module',
  'capability',
] as const;

export const FLAG_FILTER_KEYS = [
  'isParent',
  'isSubIssue',
  'isBlocked',
  'isBlocking',
] as const;

export type ValueFilterKey = (typeof VALUE_FILTER_KEYS)[number];
export type FlagFilterKey = (typeof FLAG_FILTER_KEYS)[number];
export type FilterKey = ValueFilterKey | FlagFilterKey;

export type FiltersModelType = {
  [K in ValueFilterKey]?: FilterModelType;
} & {
  [K in FlagFilterKey]?: FilterModelBooleanType;
};

export enum GroupingEnum {
  assignee = 'assignee',
  label = 'label',
  status = 'status',
  priority = 'priority',
  project = 'project',
  team = 'team',
  module = 'module',
  capability = 'capability',
}

export enum TimeBasedFilterEnum {
  All = 'All',
  PastDay = 'Past day',
  PastWeek = 'Past week',
  None = 'None',
}

export enum OrderingEnum {
  assignee = 'assignee',
  priority = 'priority',
  status = 'status',
  updated_at = 'updated_at',
  created_at = 'created_at',
}

export enum ViewEnum {
  list = 'list',
  board = 'board',
  sheet = 'sheet',
}
