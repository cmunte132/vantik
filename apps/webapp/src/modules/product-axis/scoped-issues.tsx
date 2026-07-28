import { observer } from 'mobx-react-lite';
import React from 'react';

import { IssuesViewOptions } from 'modules/issues/all/issues-view-options';
import { ListView } from 'modules/issues/all/list-view';
import { FiltersView } from 'modules/issues/filters-view/filters-view';

import { FilterTypeEnum, type FiltersModelType } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

interface ScopedIssuesProps {
  /** The modules whose issues this page shows. An empty list shows nothing. */
  moduleIds?: string[];
  /** The capability whose issues this page shows. */
  capabilityId?: string;
}

/**
 * The issue list of a module, a product or a capability.
 *
 * The scope goes in as a silent filter rather than as a query of its own. A
 * silent filter is invisible in the filter bar and applies on top of whatever
 * the person chooses there, which is what "the issues of this module, and then
 * the filters I asked for" means. It is the same mechanism the insight views
 * already use.
 */
export const ScopedIssues = observer(
  ({ moduleIds, capabilityId }: ScopedIssuesProps) => {
    const { applicationStore } = useContextStore();

    const key = `${(moduleIds ?? []).join(',')}|${capabilityId ?? ''}`;

    React.useEffect(() => {
      const scope: Partial<FiltersModelType> = {};

      if (moduleIds) {
        scope.module = {
          value: moduleIds,
          filterType: FilterTypeEnum.INCLUDES,
        };
      }

      if (capabilityId) {
        scope.capability = {
          value: [capabilityId],
          filterType: FilterTypeEnum.IS,
        };
      }

      // The store spreads what it is given straight onto the filter model, so
      // the filters go in at the top level and not under a `filters` key.
      applicationStore.updateSilentFilters(scope);

      // The scope belongs to this page. Leaving it behind would narrow the next
      // list a person opens, with nothing on screen to say why.
      return () => {
        applicationStore.deleteSilentFilter('module');
        applicationStore.deleteSilentFilter('capability');
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return (
      <>
        <FiltersView Actions={<IssuesViewOptions />} />
        <ListView />
      </>
    );
  },
);
