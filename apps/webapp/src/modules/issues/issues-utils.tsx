import { WorkflowCategoryEnum } from '@vantikhq/types';
import { sort } from 'fast-sort';
import { usePathname } from 'next/navigation';
import React from 'react';

import { type WorkflowType } from 'common/types';
import type { IssueType, LabelType, ModuleType } from 'common/types';

import { useComputedLabels } from 'hooks/labels';

import {
  TimeBasedFilterEnum,
  FilterTypeEnum,
  OrderingEnum,
  type DisplaySettingsModelType,
  type FilterModelBooleanType,
  type FilterModelType,
  type FilterModelTimeBasedType,
  type FiltersModelType,
} from 'store/application';
import {
  useContextStore,
  type StoreContextInstanceType,
} from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

interface FilterNormalType extends FilterModelType {
  key: string;
}

interface FilterBooleanType extends FilterModelBooleanType {
  key: string;
}

interface FilterTimeBasedType extends FilterModelTimeBasedType {
  key: string;
}

type FilterType = FilterNormalType | FilterBooleanType | FilterTimeBasedType;

export function filterIssue(issue: IssueType, filter: FilterType) {
  // TODO: Fix the type later
  const { key, value, filterType } = filter as FilterNormalType;
  const castedValue = value as string[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fieldValue = (issue as any)[key];

  // A filter with nothing selected is not a filter that matches nothing: it is
  // no filter at all. Reading `includes` off the missing value instead throws,
  // and the throw happens inside the list render, so the whole issues view
  // goes down rather than one row. `getFilters` builds exactly such a filter
  // for `source`, which has no case in `filterIssues`.
  if (filterType !== FilterTypeEnum.UNDEFINED && !castedValue) {
    return true;
  }

  switch (filterType) {
    case FilterTypeEnum.IS:
      return castedValue.includes(fieldValue);
    case FilterTypeEnum.IS_NOT:
      return !castedValue.includes(fieldValue);
    // INCLUDES and EXCLUDES compare against array columns — labelIds and the
    // like. A row whose array is null still has to be answered for.
    case FilterTypeEnum.INCLUDES:
      return castedValue.some((value) => (fieldValue ?? []).includes(value));
    case FilterTypeEnum.EXCLUDES:
      return !castedValue.some((value) => (fieldValue ?? []).includes(value));
    case FilterTypeEnum.UNDEFINED:
      return fieldValue === null || fieldValue === undefined;
    default:
      return true; // No filter, return all issues
  }
}

export function filterTimeBasedIssue(issue: IssueType, filter: FilterType) {
  // TODO: Fix the type later
  const { key, filterType } = filter as FilterTimeBasedType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fieldValue = (issue as any)[key];

  // Handle time-based filters
  if (Object.values(TimeBasedFilterEnum).includes(filterType)) {
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
  filters: FilterType[],
  { issuesStore, issueRelationsStore }: Partial<StoreContextInstanceType>,
  isCompleted: (stateId: string) => boolean,
) {
  return issues.filter((issue: IssueType) => {
    return filters.every((filter) => {
      switch (filter.key) {
        case 'isParent': {
          return issuesStore.isSubIssue(issue.id);
        }

        case 'isSubIssue': {
          return filter.filterType === FilterTypeEnum.IS
            ? !!issue.parentId
            : !issue.parentId;
        }

        case 'isBlocked': {
          return issueRelationsStore.isBlocked(issue.id);
        }

        case 'isBlocking': {
          return issueRelationsStore.isBlocking(issue.id);
        }

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
  const {
    status,
    assignee,
    label,
    priority,
    project,
    cycle,
    product,
    module,
    capability,
  } = filters;
  const { showSubIssues, completedFilter } = displaySettings;

  const finalFilters: FilterType[] = [];

  if (status) {
    const ids = status.value.flatMap(
      (value: string) =>
        workflows.find((workflow) => workflow.name === value)?.ids || [],
    );

    finalFilters.push({
      key: 'stateId',
      filterType: status.filterType,
      value: ids,
    });
  }

  if (assignee) {
    if (assignee.value.includes('no-user')) {
      finalFilters.push({
        key: 'assigneeId',
        filterType: FilterTypeEnum.UNDEFINED,
      });
    }

    const restAssigneeValues = assignee.value.filter(
      (a: string) => a !== 'no-user',
    );

    if (restAssigneeValues.length > 0) {
      finalFilters.push({
        key: 'assigneeId',
        filterType: assignee.filterType,
        value: restAssigneeValues,
      });
    }
  }

  if (!assignee && userId) {
    finalFilters.push({
      key: 'assigneeId',
      filterType: FilterTypeEnum.IS,
      value: [userId],
    });
  }

  if (label) {
    const ids = label.value.flatMap(
      (value: string) =>
        labels.find((label) => label.name === value)?.ids || [],
    );

    finalFilters.push({
      key: 'labelIds',
      filterType: label.filterType,
      value: ids,
    });
  }

  if (priority) {
    finalFilters.push({
      key: 'priority',
      filterType: priority.filterType,
      value: priority.value,
    });
  }

  if (project) {
    finalFilters.push({
      key: 'projectId',
      filterType: project.filterType,
      value: project.value,
    });
  }

  if (cycle) {
    finalFilters.push({
      key: 'cycleId',
      filterType: cycle.filterType,
      value: cycle.value,
    });
  }

  // A product owns modules and borrows others, and its issues are the issues of
  // all of them. This turns the product into that list of modules. A product
  // with no module gives an empty list, and then the page shows nothing, which
  // is the truth.
  if (product) {
    const ids = modules
      .filter(
        (candidate) =>
          product.value.includes(candidate.ownerProductId) ||
          (candidate.linkedProductIds ?? []).some((linked: string) =>
            product.value.includes(linked),
          ),
      )
      .map((candidate) => candidate.id);

    finalFilters.push({
      key: 'moduleIds',
      filterType: FilterTypeEnum.INCLUDES,
      value: ids,
    });
  }

  // An issue can change more than one module, so this reads an array and takes
  // the INCLUDES path in filterIssue, the same as labels.
  if (module) {
    finalFilters.push({
      key: 'moduleIds',
      filterType: module.filterType,
      value: module.value,
    });
  }

  // One capability, or none, so this compares a single value.
  if (capability) {
    finalFilters.push({
      key: 'capabilityId',
      filterType: capability.filterType,
      value: capability.value,
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

  for (const filterKey of [
    'isParent',
    'isSubIssue',
    'isBlocked',
    'isBlocking',
    'source',
  ]) {
    if (filters[filterKey as keyof FiltersModelType]) {
      finalFilters.push({
        key: filterKey,
        filterType: FilterTypeEnum.IS,
      });
    }
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
