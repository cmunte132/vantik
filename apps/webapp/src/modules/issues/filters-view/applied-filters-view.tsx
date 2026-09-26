import { observer } from 'mobx-react-lite';

import { FLAG_FILTER_KEYS, VALUE_FILTER_KEYS } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

import { FilterItemView } from './filter-item-view';
import { isEmpty } from './filter-utils';

export const AppliedFiltersView = observer(() => {
  const { applicationStore } = useContextStore();

  if (isEmpty(applicationStore.filters)) {
    return null;
  }

  return (
    <div className="flex gap-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
      {[...VALUE_FILTER_KEYS, ...FLAG_FILTER_KEYS].map((key) => (
        <FilterItemView key={key} filterKey={key} />
      ))}
    </div>
  );
});
