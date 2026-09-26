import type { FilterValues } from './filter-dropdowns/types';

import { RiCloseLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { Separator } from '@vantikhq/ui/components/separator';
import { observer } from 'mobx-react-lite';

import { useCurrentTeam } from 'hooks/teams';

import type { FilterKey, FilterTypeEnum } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

import { VALUE_FILTER_COMPONENTS } from './filter-components';
import { FilterOptionsDropdown } from './filter-options-dropdown';
import {
  FLAG_FILTERS,
  VALUE_FILTERS,
  isFlagFilter,
  operatorsFor,
} from './filter-registry';

/** One applied filter: its name, its operator, its values, and a way out. */
export const FilterItemView = observer(
  ({ filterKey }: { filterKey: FilterKey }) => {
    const { applicationStore } = useContextStore();
    const team = useCurrentTeam();
    const filter = applicationStore.filters[filterKey];

    if (!filter) {
      return null;
    }

    const onChange = (value: FilterValues) => {
      if (value.length === 0) {
        return applicationStore.deleteFilter(filterKey);
      }

      applicationStore.updateFilters({ [filterKey]: { ...filter, value } });
    };

    const onChangeFilterType = (filterType: FilterTypeEnum) => {
      applicationStore.updateFilters({
        [filterKey]: { ...filter, filterType },
      });
    };

    let name: string;
    let content: React.ReactNode;

    if (isFlagFilter(filterKey)) {
      name = FLAG_FILTERS[filterKey].name;
      content = FLAG_FILTERS[filterKey].label;
    } else {
      const { Chip } = VALUE_FILTER_COMPONENTS[filterKey];

      name = VALUE_FILTERS[filterKey].name;
      content = (
        <Chip
          value={filter.value}
          onChange={onChange}
          teamIdentifier={team?.identifier}
        />
      );
    }

    return (
      <div className="flex bg-grayAlpha-100 rounded-md items-center">
        <div className="px-2 p-1 rounded-md rounded-r-none transparent">
          {name}
        </div>
        <Separator className="bg-background-2 w-[1px]" orientation="vertical" />
        <FilterOptionsDropdown
          onChange={onChangeFilterType}
          options={operatorsFor(filterKey)}
          filterType={filter.filterType}
        />
        <Separator className="bg-background-2 w-[1px]" orientation="vertical" />
        <div className="flex items-center px-2 rounded-md rounded-l-none rounded-r-none">
          {content}
        </div>
        <Separator className="bg-background-2 w-[1px]" orientation="vertical" />

        <Button
          className="flex items-center px-1.5 py-1 rounded-md rounded-l-none"
          onClick={() => applicationStore.deleteFilter(filterKey)}
          variant="ghost"
        >
          <RiCloseLine size={16} className="hover:text-foreground" />
        </Button>
      </div>
    );
  },
);
