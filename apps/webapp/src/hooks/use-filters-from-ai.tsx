import type { FilterValues } from 'modules/issues/filters-view/filter-dropdowns/types';
import {
  isFlagFilter,
  operatorFor,
} from 'modules/issues/filters-view/filter-registry';

import { getPriorities } from 'common/priority';
import type { User } from 'common/types';

import type { FilterTypeEnum, ValueFilterKey } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

import { useUsersData } from './users';

/** What the AI filter endpoint answers: human names, keyed by filter. */
type AIFilters = Record<
  string,
  { filterType: FilterTypeEnum; value?: string[] }
>;

export function useFiltersFromAI() {
  const { applicationStore, labelsStore, workflowsStore } = useContextStore();
  const { users } = useUsersData();

  // The value filters the AI can name, and how its names become stored values.
  // Status and label filters store names, spelled the way the workspace spells
  // them; the others store ids or, for priority, a number.
  const readers: Partial<
    Record<ValueFilterKey, (names: string[]) => FilterValues>
  > = {
    status: (names) => workflowsStore.getWorkflowNames(names),
    label: (names) => labelsStore.getLabelWithValues(names),
    assignee: (names) =>
      names
        .map(
          (name) =>
            users.find((user: User) =>
              user.fullname.toLowerCase().includes(name.toLowerCase()),
            )?.id,
        )
        .filter(Boolean),
    priority: (names) =>
      names
        .map((name) => getPriorities().indexOf(name))
        .filter((index) => index > 0),
  };

  const setFilters = (filterData: AIFilters) => {
    for (const [key, requested] of Object.entries(filterData)) {
      if (isFlagFilter(key)) {
        applicationStore.updateFilters({
          [key]: { filterType: operatorFor(key, requested.filterType) },
        });
        continue;
      }

      const read = readers[key as ValueFilterKey];
      const value = read ? read(requested.value ?? []) : [];

      if (value.length === 0) {
        continue;
      }

      const current: FilterValues = applicationStore.filters[key]?.value ?? [];

      applicationStore.updateFilters({
        [key]: {
          filterType: operatorFor(key as ValueFilterKey, requested.filterType),
          value: [...new Set([...current, ...value])],
        },
      });
    }
  };

  return { setFilters };
}
