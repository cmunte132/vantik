import { WorkflowCategoryEnum } from '@vantikhq/types';
import { describe, expect, it } from 'vitest';

import type {
  IssueType,
  LabelType,
  ModuleType,
  WorkflowType,
} from 'common/types';

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

/**
 * The second axis as a filter.
 *
 * An issue names its modules and its capability. It never names a product, so a
 * product filter has to become the modules that product owns and borrows. That
 * translation is the only part of the axis that is not a direct field read, and
 * it is what every product page and every product filter depends on.
 */
describe('getFilters for the product axis', () => {
  const MODULES = [
    {
      id: 'module-server',
      name: 'Server',
      ownerProductId: 'product-cloud',
      ownerTeamId: null,
      linkedProductIds: [],
      linkedTeamIds: [],
    },
    {
      id: 'module-shared',
      name: 'Shared',
      ownerProductId: 'product-docs',
      ownerTeamId: null,
      linkedProductIds: ['product-cloud'],
      linkedTeamIds: [],
    },
    {
      id: 'module-internal',
      name: 'Internal tools',
      ownerProductId: null,
      ownerTeamId: 'team-1',
      linkedProductIds: [],
      linkedTeamIds: [],
    },
  ] as unknown as ModuleType[];

  /**
   * `getFilters` returns a union, and only some members carry a value. Every
   * assertion below is about a value, so this narrows once.
   */
  const valuesOf = (filter: unknown): string[] =>
    (filter as { value: string[] }).value;

  const forProduct = (value: string[]) =>
    getFilters(
      {
        product: { value, filterType: FilterTypeEnum.IS },
      } as unknown as FiltersModelType,
      DISPLAY_SETTINGS,
      WORKFLOWS,
      LABELS,
      undefined,
      MODULES,
    ).find((filter) => filter.key === 'moduleIds');

  it('turns a product into the modules it owns and the ones it borrows', () => {
    expect(forProduct(['product-cloud'])).toEqual({
      key: 'moduleIds',
      filterType: FilterTypeEnum.INCLUDES,
      value: ['module-server', 'module-shared'],
    });
  });

  it('leaves a module that belongs to a team out of every product', () => {
    expect(valuesOf(forProduct(['product-cloud']))).not.toContain(
      'module-internal',
    );
    expect(valuesOf(forProduct(['product-docs']))).not.toContain(
      'module-internal',
    );
  });

  /**
   * A product with no module gives an empty list, and the page then shows
   * nothing. That is the truth, and it is better than a filter that quietly
   * matches everything.
   */
  it('gives an empty list for a product that owns nothing', () => {
    expect(forProduct(['product-nobody'])).toEqual({
      key: 'moduleIds',
      filterType: FilterTypeEnum.INCLUDES,
      value: [],
    });
  });

  it('reads a module whose linked list was never set', () => {
    const filters = getFilters(
      {
        product: { value: ['product-cloud'], filterType: FilterTypeEnum.IS },
      } as unknown as FiltersModelType,
      DISPLAY_SETTINGS,
      WORKFLOWS,
      LABELS,
      undefined,
      [
        {
          id: 'module-old',
          ownerProductId: 'product-cloud',
          linkedProductIds: undefined,
        },
      ] as unknown as ModuleType[],
    );

    expect(
      valuesOf(filters.find((filter) => filter.key === 'moduleIds')),
    ).toEqual(['module-old']);
  });

  it('asks for the modules of an issue as an array, the way labels work', () => {
    const filters = getFilters(
      {
        module: {
          value: ['module-server'],
          filterType: FilterTypeEnum.INCLUDES,
        },
      } as unknown as FiltersModelType,
      DISPLAY_SETTINGS,
      WORKFLOWS,
      LABELS,
    );

    expect(filters).toContainEqual({
      key: 'moduleIds',
      filterType: FilterTypeEnum.INCLUDES,
      value: ['module-server'],
    });
  });

  it('asks for the capability of an issue as one value', () => {
    const filters = getFilters(
      {
        capability: {
          value: ['capability-login'],
          filterType: FilterTypeEnum.IS,
        },
      } as unknown as FiltersModelType,
      DISPLAY_SETTINGS,
      WORKFLOWS,
      LABELS,
    );

    expect(filters).toContainEqual({
      key: 'capabilityId',
      filterType: FilterTypeEnum.IS,
      value: ['capability-login'],
    });
  });

  /**
   * A product page sets the product filter and a person can set a module filter
   * on top of it. Both land as `moduleIds`, and `filterIssue` runs every filter,
   * so the two narrow each other rather than one replacing the other.
   */
  it('keeps a product scope and a module choice as two filters', () => {
    const filters = getFilters(
      {
        product: { value: ['product-cloud'], filterType: FilterTypeEnum.IS },
        module: {
          value: ['module-server'],
          filterType: FilterTypeEnum.INCLUDES,
        },
      } as unknown as FiltersModelType,
      DISPLAY_SETTINGS,
      WORKFLOWS,
      LABELS,
      undefined,
      MODULES,
    );

    expect(filters.filter((filter) => filter.key === 'moduleIds')).toHaveLength(
      2,
    );
  });
});
