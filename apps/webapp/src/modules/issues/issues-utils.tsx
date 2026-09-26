import { WorkflowCategoryEnum } from '@vantikhq/types';
import { sort } from 'fast-sort';
import { usePathname } from 'next/navigation';
import React from 'react';

import { type WorkflowType } from 'common/types';
import type { IssueType, LabelType, ModuleType } from 'common/types';

import { useComputedLabels } from 'hooks/labels';

import {
  FLAG_FILTER_KEYS,
  TimeBasedFilterEnum,
  FilterTypeEnum,
  OrderingEnum,
  VALUE_FILTER_KEYS,
  type DisplaySettingsModelType,
  type FiltersModelType,
} from 'store/application';
import {
  useContextStore,
  type StoreContextInstanceType,
} from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

import {
  FLAG_FILTERS,
  VALUE_FILTERS,
  isFlagFilter,
  type IssuePredicate,
} from './filters-view/filter-registry';

export function filterIssue(issue: IssueType, filter: IssuePredicate) {
  const { key, value, filterType } = filter;

  // An unset field is compared as `null`, the value a "No …" choice stands for.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fieldValue = (issue as any)[key] ?? null;

  // A filter with nothing selected is not a filter that matches nothing: it is
  // no filter at all. Reading `includes` off the missing value instead throws,
  // and the throw happens inside the list render, so the whole issues view
  // goes down rather than one row.
  if (filterType !== FilterTypeEnum.UNDEFINED && !value) {
    return true;
  }

  switch (filterType) {
    case FilterTypeEnum.IS:
      return value.includes(fieldValue);
    case FilterTypeEnum.IS_NOT:
      return !value.includes(fieldValue);
    // INCLUDES and EXCLUDES compare against array columns — labelIds and the
    // like. A row whose array is null still has to be answered for.
    case FilterTypeEnum.INCLUDES:
      return value.some((candidate) => (fieldValue ?? []).includes(candidate));
    case FilterTypeEnum.EXCLUDES:
      return !value.some((candidate) => (fieldValue ?? []).includes(candidate));
    case FilterTypeEnum.UNDEFINED:
      return fieldValue === null;
    default:
      return true; // No filter, return all issues
  }
}

export function filterTimeBasedIssue(issue: IssueType, filter: IssuePredicate) {
  const { key, filterType } = filter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fieldValue = (issue as any)[key];

  // Handle time-based filters
  if (
    Object.values(TimeBasedFilterEnum).includes(
      filterType as TimeBasedFilterEnum,
    )
  ) {
    const now = new Date().getTime();

    switch (filterType) {
      case TimeBasedFilterEnum.PastDay:
        return new Date(fieldValue).getTime() >= now - 24 * 60 * 60 * 1000; // Last 24 hours
      case TimeBasedFilterEnum.PastWeek:
        return new Date(fieldValue).getTime() >= now - 7 * 24 * 60 * 60 * 1000; // Last 7 days
    }
  }

  return true;
}

export function filterIssues(
  issues: IssueType[],
  filters: IssuePredicate[],
  { issuesStore, issueRelationsStore }: Partial<StoreContextInstanceType>,
  isCompleted: (stateId: string) => boolean,
) {
  return issues.filter((issue: IssueType) => {
    return filters.every((filter) => {
      if (isFlagFilter(filter.key)) {
        const matches = FLAG_FILTERS[filter.key].matches(issue, {
          issuesStore,
          issueRelationsStore,
        });

        return filter.filterType === FilterTypeEnum.IS_NOT ? !matches : matches;
      }

      switch (filter.key) {
        case 'updatedAt': {
          return filterTimeBasedIssue(issue, filter);
        }

        case 'completed_updatedAt': {
          if (!isCompleted(issue.stateId)) {
            return true;
          }

          return (
            isCompleted(issue.stateId) &&
            filterTimeBasedIssue(issue, { ...filter, key: 'updatedAt' })
          );
        }

        default:
          return filterIssue(issue, filter);
      }
    });
  });
}

export function getSortArray(displaySettings: DisplaySettingsModelType) {
  const by = [];

  switch (displaySettings.ordering) {
    case OrderingEnum.assignee: {
      by.push({ asc: (issue: IssueType) => issue.assigneeId });
      break;
    }

    case OrderingEnum.updated_at: {
      by.push({ desc: (issue: IssueType) => issue.updatedAt });
      break;
    }

    case OrderingEnum.created_at: {
      by.push({ desc: (issue: IssueType) => issue.createdAt });
      break;
    }

    case OrderingEnum.priority: {
      by.push({ asc: (issue: IssueType) => issue.priority });
      break;
    }

    case OrderingEnum.status: {
      by.push({ asc: (issue: IssueType) => issue.stateId });
      break;
    }
  }

  return by;
}

export function getFilters(
  filters: FiltersModelType = {},
  displaySettings: DisplaySettingsModelType,
  workflows: WorkflowType[],
  labels: LabelType[],
  userId?: string,
  /**
   * Every module of the workspace. A product filter needs them, because an
   * issue names its modules and never its product.
   */
  modules: ModuleType[] = [],
) {
  const { showSubIssues, completedFilter } = displaySettings;
  const context = { workflows, labels, modules };

  const finalFilters: IssuePredicate[] = [];

  for (const key of VALUE_FILTER_KEYS) {
    if (filters[key]) {
      finalFilters.push(
        ...VALUE_FILTERS[key].predicates(filters[key], context),
      );
    }
  }

  for (const key of FLAG_FILTER_KEYS) {
    if (filters[key]) {
      finalFilters.push({ key, filterType: filters[key].filterType });
    }
  }

  // My issues are the ones assigned to me, until an assignee filter says whose.
  if (!filters.assignee && userId) {
    finalFilters.push({
      key: 'assigneeId',
      filterType: FilterTypeEnum.IS,
      value: [userId],
    });
  }

  if (!showSubIssues) {
    finalFilters.push({
      key: 'parentId',
      filterType: FilterTypeEnum.UNDEFINED,
      value: undefined,
    });
  }

  if (
    completedFilter &&
    (completedFilter === TimeBasedFilterEnum.PastDay ||
      completedFilter === TimeBasedFilterEnum.PastWeek)
  ) {
    finalFilters.push({
      key: 'completed_updatedAt',
      filterType: completedFilter,
    });
  }

  if (completedFilter && completedFilter === TimeBasedFilterEnum.None) {
    const filteredWorkflows = workflows.filter(
      (workflow) =>
        workflow.category === WorkflowCategoryEnum.COMPLETED ||
        workflow.category === WorkflowCategoryEnum.CANCELED,
    );

    finalFilters.push({
      key: 'stateId',
      filterType: FilterTypeEnum.IS_NOT,
      value: filteredWorkflows.flatMap((workflow: WorkflowType) =>
        workflow.ids ? workflow.ids : workflow.id,
      ),
    });
  }

  return finalFilters;
}

export function useFilterIssues(
  issues: IssueType[],
  workflows: WorkflowType[],
  filterSilent: boolean = true,
): IssueType[] {
  const pathname = usePathname();
  const user = React.useContext(UserContext);

  const {
    applicationStore,
    linkedIssuesStore,
    issuesStore,
    issueRelationsStore,
    modulesStore,
  } = useContextStore();
  const { labels } = useComputedLabels();
  const modules: ModuleType[] = modulesStore.getModules;

  const isCompleted = (stateId: string) => {
    const filteredWorkflows = workflows.filter(
      (workflow: WorkflowType) =>
        workflow.category === WorkflowCategoryEnum.COMPLETED ||
        workflow.category === WorkflowCategoryEnum.CANCELED,
    );

    return !!filteredWorkflows.find(
      (workflow: WorkflowType) => workflow.id === stateId,
    );
  };

  return React.useMemo(() => {
    const filters = getFilters(
      applicationStore.filters,
      applicationStore.displaySettings,
      workflows,
      labels,
      pathname.includes('my-issues') ? user.id : undefined,
      modules,
    );

    const silentFilters = filterSilent
      ? getFilters(
          applicationStore.silentFilters,
          applicationStore.displaySettings,
          workflows,
          labels,
          pathname.includes('my-issues') ? user.id : undefined,
          modules,
        )
      : [];

    const filteredIssues = filterIssues(
      issues,
      [...filters, ...silentFilters],
      {
        linkedIssuesStore,
        issuesStore,
        issueRelationsStore,
      },
      isCompleted,
    );

    return sort(filteredIssues).by(
      getSortArray(applicationStore.displaySettings),
    );
    // The silent filters belong in this list. They are what scopes a page to
    // one module, product or capability, and a memo that does not watch them
    // returns the previous answer: the product page then shows every issue in
    // the workspace, which reads as a working page with wrong contents. The
    // insight views never showed this because they change a visible filter at
    // the same time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applicationStore.filters,
    applicationStore.silentFilters,
    applicationStore.displaySettings,
    issues,
    // A product filter reads the modules, so a module that arrives or changes
    // owner has to make this run again.
    modules,
  ]);
}
