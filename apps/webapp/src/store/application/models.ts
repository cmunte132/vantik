import { types } from 'mobx-state-tree';

import {
  FLAG_FILTER_KEYS,
  VALUE_FILTER_KEYS,
  type FlagFilterKey,
  type ValueFilterKey,
} from './types';

export const FilterModel = types.model({
  value: types.union(types.array(types.string), types.array(types.number)),
  filterType: types.enumeration(['IS', 'IS_NOT', 'INCLUDES', 'EXCLUDES']),
});

export const FilterBooleanModel = types.model({
  filterType: types.enumeration(['IS', 'IS_NOT', 'INCLUDES', 'EXCLUDES']),
});

const valueFilter = () => types.union(types.undefined, FilterModel);
const flagFilter = () => types.union(types.undefined, FilterBooleanModel);

/**
 * One optional field per filter key. Saved views and local storage hold this
 * shape, and a stored key that is no longer a filter is dropped on load.
 */
export const FiltersModel = types.model({
  ...(Object.fromEntries(
    VALUE_FILTER_KEYS.map((key) => [key, valueFilter()]),
  ) as {
    [K in ValueFilterKey]: ReturnType<typeof valueFilter>;
  }),
  ...(Object.fromEntries(
    FLAG_FILTER_KEYS.map((key) => [key, flagFilter()]),
  ) as {
    [K in FlagFilterKey]: ReturnType<typeof flagFilter>;
  }),
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
