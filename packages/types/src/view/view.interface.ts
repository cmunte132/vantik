export enum FilterTypeEnum {
  IS = 'IS',
  IS_NOT = 'IS_NOT',
  INCLUDES = 'INCLUDES',
  EXCLUDES = 'EXCLUDES',
  UNDEFINED = 'UNDEFINED',
  LTE = 'LTE',
  LT = 'LT',
  GTE = 'GTE',
  GT = 'GT',
}

export enum FilterKeyEnum {
  label = 'label',
  status = 'status',
  assignee = 'assignee',
  priority = 'priority',
  dueDate = 'dueDate',
  updatedAt = 'updatedAt',
  createdAt = 'createdAt',
  project = 'project',
  /**
   * The modules an issue changes. A list, so INCLUDES and EXCLUDES are the
   * filter types that fit it.
   */
  module = 'module',
  /** The capability an issue delivers. One value, so IS and IS_NOT fit it. */
  capability = 'capability',
}

export enum BooleanFilterKeyEnum {
  isBlocked = 'isBlocked',
  isBlocking = 'isBlocking',
  isDuplicate = 'isDuplicate',
  isDuplicateOf = 'isDuplicateOf',
  isRelated = 'isRelated',
  isParent = 'isParent',
  isSubIssue = 'isSubIssue',
}

export type FilterKey = FilterKeyEnum | BooleanFilterKeyEnum;

export interface FilterValue {
  value?: string | string[];
  filterType: FilterTypeEnum;
}
