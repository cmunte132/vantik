import { WorkflowCategoryEnum } from '@vantikhq/types';
import { describe, expect, it } from 'vitest';

import type { IssueType, LabelType, WorkflowType } from 'common/types';

import {
  FilterTypeEnum,
  TimeBasedFilterEnum,
  type DisplaySettingsModelType,
  type FiltersModelType,
} from 'store/application';

import { filterIssue, getFilters } from './issues-utils';

/**
 * These two functions decide what the issues list contains. They run over
 * every row on every render, so anything they throw on takes the whole list
 * with it, and anything they wrongly exclude reads as "my issues disappeared".
 */

function issue(overrides: Partial<IssueType> = {}): IssueType {
  return {
    id: 'issue-1',
    title: 'An issue',
    number: 1,
    stateId: 'state-todo',
    teamId: 'team-1',
    assigneeId: 'user-1',
    labelIds: ['label-bug'],
    parentId: null,
    projectId: null,
    cycleId: null,
    priority: 0,
    ...overrides,
  } as unknown as IssueType;
}

const DISPLAY_SETTINGS: DisplaySettingsModelType = {
  view: 'list',
  grouping: 'status',
  ordering: 'status',
  completedFilter: 'All',
  showSubIssues: true,
  showEmptyGroups: false,
} as unknown as DisplaySettingsModelType;

const WORKFLOWS = [
  {
    id: 'state-todo',
    name: 'Todo',
    ids: ['state-todo'],
    category: WorkflowCategoryEnum.UNSTARTED,
  },
  {
    id: 'state-done',
    name: 'Done',
    ids: ['state-done'],
    category: WorkflowCategoryEnum.COMPLETED,
  },
] as unknown as WorkflowType[];

const LABELS = [
  { id: 'label-bug', name: 'bug', ids: ['label-bug'] },
] as unknown as LabelType[];

describe('filterIssue', () => {
  it('keeps the rows whose field is one of the selected values', () => {
    const filter = {
      key: 'assigneeId',
      filterType: FilterTypeEnum.IS,
      value: ['user-1'],
    };

    expect(filterIssue(issue(), filter)).toBe(true);
    expect(filterIssue(issue({ assigneeId: 'user-2' }), filter)).toBe(false);
  });

  it('drops the rows whose field is one of the selected values for IS_NOT', () => {
    const filter = {
      key: 'assigneeId',
      filterType: FilterTypeEnum.IS_NOT,
      value: ['user-1'],
    };

    expect(filterIssue(issue(), filter)).toBe(false);
    expect(filterIssue(issue({ assigneeId: 'user-2' }), filter)).toBe(true);
  });

  it('matches array columns on any of the selected values', () => {
    const filter = {
      key: 'labelIds',
      filterType: FilterTypeEnum.INCLUDES,
      value: ['label-bug', 'label-chore'],
    };

    expect(filterIssue(issue(), filter)).toBe(true);
    expect(filterIssue(issue({ labelIds: ['label-other'] }), filter)).toBe(
      false,
    );
  });

  it('answers for a row whose array column is missing instead of throwing', () => {
    const filter = {
      key: 'labelIds',
      filterType: FilterTypeEnum.INCLUDES,
      value: ['label-bug'],
    };

    expect(filterIssue(issue({ labelIds: undefined }), filter)).toBe(false);
  });

  it('selects the rows with nothing set for UNDEFINED', () => {
    const filter = { key: 'assigneeId', filterType: FilterTypeEnum.UNDEFINED };

    expect(filterIssue(issue({ assigneeId: null }), filter)).toBe(true);
    expect(filterIssue(issue(), filter)).toBe(false);
  });

  it('lets everything through when the filter carries no values', () => {
    // `getFilters` builds one of these for `source`, and `filterIssues` has no
    // case for that key, so it lands here. Reading `includes` off the absent
    // value throws inside the list render and takes the whole view down.
    const filter = { key: 'source', filterType: FilterTypeEnum.IS };

    expect(filterIssue(issue(), filter)).toBe(true);
  });
});

describe('getFilters', () => {
  it('resolves status names to the workflow ids behind them', () => {
    const filters = {
      status: { value: ['Todo'], filterType: FilterTypeEnum.IS },
    } as unknown as FiltersModelType;

    expect(
      getFilters(filters, DISPLAY_SETTINGS, WORKFLOWS, LABELS),
    ).toContainEqual({
      key: 'stateId',
      filterType: FilterTypeEnum.IS,
      value: ['state-todo'],
    });
  });

  it('resolves label names to label ids', () => {
    const filters = {
      label: { value: ['bug'], filterType: FilterTypeEnum.INCLUDES },
    } as unknown as FiltersModelType;

    expect(
      getFilters(filters, DISPLAY_SETTINGS, WORKFLOWS, LABELS),
    ).toContainEqual({
      key: 'labelIds',
      filterType: FilterTypeEnum.INCLUDES,
      value: ['label-bug'],
    });
  });

  it('turns the no-user assignee choice into an unset check', () => {
    const filters = {
      assignee: { value: ['no-user'], filterType: FilterTypeEnum.IS },
    } as unknown as FiltersModelType;

    expect(getFilters(filters, DISPLAY_SETTINGS, WORKFLOWS, LABELS)).toEqual([
      { key: 'assigneeId', filterType: FilterTypeEnum.UNDEFINED },
    ]);
  });

  it('narrows to the current user only when no assignee filter is set', () => {
    const withUser = getFilters(
      {} as FiltersModelType,
      DISPLAY_SETTINGS,
      WORKFLOWS,
      LABELS,
      'user-1',
    );

    expect(withUser).toContainEqual({
      key: 'assigneeId',
      filterType: FilterTypeEnum.IS,
      value: ['user-1'],
    });

    const withExplicitAssignee = getFilters(
      {
        assignee: { value: ['user-2'], filterType: FilterTypeEnum.IS },
      } as unknown as FiltersModelType,
      DISPLAY_SETTINGS,
      WORKFLOWS,
      LABELS,
      'user-1',
    );

    expect(withExplicitAssignee).not.toContainEqual({
      key: 'assigneeId',
      filterType: FilterTypeEnum.IS,
      value: ['user-1'],
    });
  });

  it('hides sub-issues by asking for rows with no parent', () => {
    const filters = getFilters(
      {} as FiltersModelType,
      { ...DISPLAY_SETTINGS, showSubIssues: false },
      WORKFLOWS,
      LABELS,
    );

    expect(filters).toContainEqual({
      key: 'parentId',
      filterType: FilterTypeEnum.UNDEFINED,
      value: undefined,
    });
  });

  it('excludes completed and cancelled states when completed issues are hidden', () => {
    const filters = getFilters(
      {} as FiltersModelType,
      { ...DISPLAY_SETTINGS, completedFilter: TimeBasedFilterEnum.None },
      WORKFLOWS,
      LABELS,
    );

    expect(filters).toContainEqual({
      key: 'stateId',
      filterType: FilterTypeEnum.IS_NOT,
      value: ['state-done'],
    });
  });

  it('produces a source filter the row filter can survive', () => {
    const filters = getFilters(
      {
        source: { value: ['github'], filterType: FilterTypeEnum.IS },
      } as unknown as FiltersModelType,
      DISPLAY_SETTINGS,
      WORKFLOWS,
      LABELS,
    );

    const sourceFilter = filters.find((filter) => filter.key === 'source');

    expect(sourceFilter).toBeDefined();
    expect(() => filterIssue(issue(), sourceFilter)).not.toThrow();
  });
});
