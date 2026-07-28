import { types } from 'mobx-state-tree';

export const FilterModel = types.model({
  value: types.union(types.array(types.string), types.array(types.number)),
  filterType: types.enumeration(['IS', 'IS_NOT', 'INCLUDES', 'EXCLUDES']),
});

export const FilterBooleanModel = types.model({
  filterType: types.enumeration(['IS', 'IS_NOT', 'INCLUDES', 'EXCLUDES']),
});

export const FiltersModel = types.model({
  assignee: types.union(types.undefined, FilterModel),
  status: types.union(types.undefined, FilterModel),
  label: types.union(types.undefined, FilterModel),
  priority: types.union(types.undefined, FilterModel),
  project: types.union(types.undefined, FilterModel),
  cycle: types.union(types.undefined, FilterModel),

  // The product axis. An issue holds `moduleIds` and `capabilityId`, and it
  // holds no product. A product filter reads as the modules of that product,
  // which `getFilters` works out from the module store.
  product: types.union(types.undefined, FilterModel),
  module: types.union(types.undefined, FilterModel),
  capability: types.union(types.undefined, FilterModel),

  // For issues coming from Github
  source: types.union(types.undefined, FilterModel),

  isParent: types.union(types.undefined, FilterBooleanModel),
  isSubIssue: types.union(types.undefined, FilterBooleanModel),
  isBlocked: types.union(types.undefined, FilterBooleanModel),
  isBlocking: types.union(types.undefined, FilterBooleanModel),
});

export const SilentFiltersModel = types.union(types.undefined, FiltersModel);

export const DisplaySettingsModel = types.model({
  view: types.enumeration(['list', 'board', 'sheet']),
  grouping: types.enumeration([
    'assignee',
    'priority',
    'status',
    'label',
    'project',
    'team',
    'module',
    'capability',
  ]),
  ordering: types.enumeration([
    'assignee',
    'priority',
    'status',
    'created_at',
    'updated_at',
  ]),
  completedFilter: types.enumeration(['All', 'Past day', 'Past week', 'None']),
  showSubIssues: types.boolean,
  showEmptyGroups: types.boolean,
});
