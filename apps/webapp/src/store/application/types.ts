export interface UpdateBody {
  filters: Partial<FiltersModelType>;
}

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

export interface FilterModelBooleanType {
  filterType: FilterTypeEnum;
}

export interface FiltersModelType {
  assignee?: FilterModelType;
  status?: FilterModelType;
  label?: FilterModelType;
  priority?: FilterModelType;
  project?: FilterModelType;
  cycle?: FilterModelType;

  // The product axis. `module` compares against Issue.moduleIds, which is an
  // array, so it uses INCLUDES the way `label` does. `capability` compares
  // against one id and uses IS. `product` names no field on an issue at all:
  // `getFilters` turns it into the modules of that product.
  product?: FilterModelType;
  module?: FilterModelType;
  capability?: FilterModelType;

  // For issues coming from Github
  source?: FilterModelType;

  isParent?: FilterModelBooleanType;
  isSubIssue?: FilterModelBooleanType;
  isBlocked?: FilterModelBooleanType;
  isBlocking?: FilterModelBooleanType;
}

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
