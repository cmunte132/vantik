import { describe, expect, it } from 'vitest';

import type { IssueType } from 'common/types';

import {
  changeForDrop,
  draggableIdFor,
  getIssueRows,
  issueIdOfDraggable,
  NO_GROUP,
  sortIntoGroups,
  type Group,
  type Grouping,
} from './grouping';

/**
 * One description groups the list and the board for every grouping. These
 * tests hold the rules the views read from it, in each shape a field comes in:
 * a list (modules, labels), one id (a capability, a project), one id per team
 * (a status), and a number whose zero means nothing (a priority).
 */

function group(id: string, values: Group['values'] = [{ value: id }]): Group {
  return { id, name: id, icon: null, values };
}

const MODULES: Grouping = {
  field: 'moduleIds',
  isArray: true,
  listId: 'module-list',
  groups: [group('module-server'), group('module-webapp')],
  empty: { name: 'No module', icon: null, value: null },
};

const CAPABILITIES: Grouping = {
  field: 'capabilityId',
  isArray: false,
  listId: 'capability-list',
  groups: [group('capability-login'), group('capability-search')],
  empty: { name: 'No capability', icon: null, value: null },
};

// "Todo" exists in two teams, and a view over both shows it once.
const STATUSES: Grouping = {
  field: 'stateId',
  isArray: false,
  listId: 'status-list',
  groups: [
    group('todo', [
      { value: 'todo-a', teamId: 'team-a' },
      { value: 'todo-b', teamId: 'team-b' },
    ]),
    group('done', [
      { value: 'done-a', teamId: 'team-a' },
      { value: 'done-b', teamId: 'team-b' },
    ]),
  ],
};

// "Bug" is a label of the workspace and of team B; "Infra" only of team B.
const LABELS: Grouping = {
  field: 'labelIds',
  isArray: true,
  listId: 'label-list',
  groups: [
    group('bug', [
      { value: 'bug-workspace', teamId: null },
      { value: 'bug-b', teamId: 'team-b' },
    ]),
    group('infra', [{ value: 'infra-b', teamId: 'team-b' }]),
  ],
  empty: { name: 'No label', icon: null, value: null },
};

const PRIORITIES: Grouping = {
  field: 'priority',
  isArray: false,
  listId: 'priority-list',
  groups: [1, 2, 3, 4].map((priority) =>
    group(String(priority), [{ value: priority }]),
  ),
  empty: { name: 'No priority', icon: null, value: 0 },
};

function issue(overrides: Partial<IssueType> = {}): IssueType {
  return {
    id: 'issue-1',
    teamId: 'team-a',
    moduleIds: [],
    labelIds: [],
    capabilityId: null,
    priority: 0,
    stateId: 'todo-a',
    ...overrides,
  } as unknown as IssueType;
}

function idsIn(grouping: Grouping, issues: IssueType[], key: string) {
  return sortIntoGroups(issues, grouping)
    .get(key)
    ?.map((subject) => subject.id);
}

describe('sortIntoGroups', () => {
  it('puts an issue under the module that it names', () => {
    const subject = issue({ moduleIds: ['module-server'] });

    expect(idsIn(MODULES, [subject], 'module-server')).toEqual(['issue-1']);
    expect(idsIn(MODULES, [subject], 'module-webapp')).toEqual([]);
  });

  /**
   * An issue can change two modules, and it belongs under both. This is what a
   * label already does, and it is the honest shape: the work is in two places.
   */
  it('puts an issue under each of the modules that it names', () => {
    const subject = issue({ moduleIds: ['module-server', 'module-webapp'] });

    expect(idsIn(MODULES, [subject], 'module-server')).toEqual(['issue-1']);
    expect(idsIn(MODULES, [subject], 'module-webapp')).toEqual(['issue-1']);
  });

  it('puts an issue under the one capability that it names', () => {
    const subject = issue({ capabilityId: 'capability-login' });

    expect(idsIn(CAPABILITIES, [subject], 'capability-login')).toEqual([
      'issue-1',
    ]);
    expect(idsIn(CAPABILITIES, [subject], NO_GROUP)).toEqual([]);
  });

  it('finds the issues that name nothing', () => {
    expect(idsIn(MODULES, [issue()], NO_GROUP)).toEqual(['issue-1']);
    expect(idsIn(CAPABILITIES, [issue()], NO_GROUP)).toEqual(['issue-1']);
  });

  it('reads an issue whose module list was never set', () => {
    const subject = issue({ moduleIds: undefined });

    expect(idsIn(MODULES, [subject], NO_GROUP)).toEqual(['issue-1']);
  });

  /**
   * A merged status has one id per team. The list matched a merged id against
   * the issue's by substring, and the label list matched it exactly, so an
   * issue with a label that two teams share sat under no header at all.
   */
  it('groups the statuses of two teams that share a name', () => {
    const issues = [
      issue({ id: 'issue-a', stateId: 'todo-a' }),
      issue({ id: 'issue-b', teamId: 'team-b', stateId: 'todo-b' }),
    ];

    expect(idsIn(STATUSES, issues, 'todo')).toEqual(['issue-a', 'issue-b']);
  });

  it('groups the labels of two teams that share a name', () => {
    const issues = [
      issue({ id: 'issue-a', labelIds: ['bug-workspace'] }),
      issue({ id: 'issue-b', teamId: 'team-b', labelIds: ['bug-b'] }),
    ];

    expect(idsIn(LABELS, issues, 'bug')).toEqual(['issue-a', 'issue-b']);
  });

  it('puts an issue once under a group it names twice', () => {
    const subject = issue({
      teamId: 'team-b',
      labelIds: ['bug-workspace', 'bug-b'],
    });

    expect(idsIn(LABELS, [subject], 'bug')).toEqual(['issue-1']);
  });

  it('has no group of nothing where every issue names a group', () => {
    expect(sortIntoGroups([issue()], STATUSES).has(NO_GROUP)).toBe(false);
  });

  /**
   * Zero is no priority, and so is null. The board read only zero, so an issue
   * whose priority was never set sat in no column, and the list showed a
   * nameless header for zero beside its header for no value.
   */
  it('reads a priority of zero or null as no priority', () => {
    const issues = [
      issue({ id: 'zero', priority: 0 }),
      issue({ id: 'unset', priority: null }),
      issue({ id: 'urgent', priority: 1 }),
    ];

    expect(idsIn(PRIORITIES, issues, NO_GROUP)).toEqual(['zero', 'unset']);
    expect(idsIn(PRIORITIES, issues, '1')).toEqual(['urgent']);
    expect([...sortIntoGroups(issues, PRIORITIES).keys()]).toEqual([
      '1',
      '2',
      '3',
      '4',
      NO_GROUP,
    ]);
  });

  it('leaves out an issue whose value names no shown group', () => {
    const sorted = sortIntoGroups([issue({ stateId: 'hidden' })], STATUSES);

    expect([...sorted.values()].flat()).toEqual([]);
  });
});

/**
 * A suggestion is not an assignment.
 *
 * The classifier writes `IssueSuggestion.suggestedModuleIds`, and a person
 * accepts it before it reaches `Issue.moduleIds`. Grouping reads the issue and
 * nothing else, so a board never fills with modules that only a fast model
 * believed in.
 */
describe('grouping reads assigned modules only', () => {
  const withSuggestion = (overrides: Record<string, unknown>) =>
    issue({
      moduleIds: [],
      // Present on the object to prove it is not consulted: a real issue in the
      // store never carries this, and a future refactor that reached for a
      // suggestion would have to reach past this field to fail.
      suggestedModuleIds: ['module-server'],
      ...overrides,
    } as Partial<IssueType>);

  it('leaves an issue with only a suggestion in the no-module group', () => {
    const subject = withSuggestion({});

    expect(idsIn(MODULES, [subject], 'module-server')).toEqual([]);
    expect(idsIn(MODULES, [subject], NO_GROUP)).toEqual(['issue-1']);
  });

  it('groups an issue once the module is assigned', () => {
    const subject = withSuggestion({ moduleIds: ['module-server'] });

    expect(idsIn(MODULES, [subject], 'module-server')).toEqual(['issue-1']);
    expect(idsIn(MODULES, [subject], NO_GROUP)).toEqual([]);
  });
});

describe('getIssueRows', () => {
  const noRelations = () => false;

  it('puts a header over the issues of each group, in order', () => {
    const issues = [
      issue({ id: 'login', capabilityId: 'capability-login' }),
      issue({ id: 'none' }),
    ];

    expect(getIssueRows(issues, CAPABILITIES, false, noRelations)).toEqual([
      { type: 'header', key: 'capability-login' },
      { type: 'issue', issueId: 'login', hasRelations: false },
      { type: 'header', key: NO_GROUP },
      { type: 'issue', issueId: 'none', hasRelations: false },
    ]);
  });

  it('shows the empty groups only when asked', () => {
    const issues = [issue({ capabilityId: 'capability-login' })];

    expect(
      getIssueRows(issues, CAPABILITIES, true, noRelations)
        .filter((row) => row.type === 'header')
        .map((row) => row.type === 'header' && row.key),
    ).toEqual(['capability-login', 'capability-search', NO_GROUP]);
  });
});

describe('changeForDrop', () => {
  const drop = (
    grouping: Grouping,
    subject: IssueType,
    from: string,
    to: string,
  ) => changeForDrop(subject, grouping, from, to);

  it('moves an issue from one module to another', () => {
    expect(
      drop(
        MODULES,
        issue({ moduleIds: ['module-server'] }),
        'module-server',
        'module-webapp',
      ),
    ).toEqual({ moduleIds: ['module-webapp'] });
  });

  it('gives a module to an issue that had none', () => {
    expect(drop(MODULES, issue(), NO_GROUP, 'module-server')).toEqual({
      moduleIds: ['module-server'],
    });
  });

  it('takes the module away when the issue goes to the empty column', () => {
    expect(
      drop(
        MODULES,
        issue({ moduleIds: ['module-server'] }),
        'module-server',
        NO_GROUP,
      ),
    ).toEqual({ moduleIds: [] });
  });

  /**
   * A drag says where the issue now belongs. It says nothing about a module
   * that no column in the drag showed, so that module stays.
   */
  it('leaves the other modules of the issue alone', () => {
    expect(
      drop(
        MODULES,
        issue({ moduleIds: ['module-server', 'module-shared'] }),
        'module-server',
        'module-webapp',
      ),
    ).toEqual({ moduleIds: ['module-shared', 'module-webapp'] });
  });

  it('adds no second copy of a module the issue already names', () => {
    expect(
      drop(
        MODULES,
        issue({ moduleIds: ['module-server', 'module-webapp'] }),
        'module-server',
        'module-webapp',
      ),
    ).toEqual({ moduleIds: ['module-webapp'] });
  });

  it('writes nothing when the issue lands where it started', () => {
    expect(
      drop(
        MODULES,
        issue({ moduleIds: ['module-server'] }),
        'module-server',
        'module-server',
      ),
    ).toBeUndefined();
  });

  it('replaces the capability, and clears it in the empty column', () => {
    const subject = issue({ capabilityId: 'capability-login' });

    expect(
      drop(CAPABILITIES, subject, 'capability-login', 'capability-search'),
    ).toEqual({ capabilityId: 'capability-search' });
    expect(drop(CAPABILITIES, subject, 'capability-login', NO_GROUP)).toEqual({
      capabilityId: null,
    });
  });

  /**
   * The project board wrote the assignee column's sentinel check, so a drop on
   * "No project" sent the string `no-project` as the project.
   */
  it('writes null, not the column id, for the column of nothing', () => {
    const projects: Grouping = {
      field: 'projectId',
      isArray: false,
      listId: 'project-list',
      groups: [group('project-1')],
      empty: { name: 'No project', icon: null, value: null },
    };

    expect(
      drop(projects, issue({ projectId: 'project-1' }), 'project-1', NO_GROUP),
    ).toEqual({ projectId: null });
  });

  it('writes the status of the issue’s own team', () => {
    const subject = issue({ teamId: 'team-b', stateId: 'todo-b' });

    expect(drop(STATUSES, subject, 'todo', 'done')).toEqual({
      stateId: 'done-b',
    });
  });

  it('swaps a label for the one the issue’s team can hold', () => {
    const subject = issue({ teamId: 'team-b', labelIds: ['infra-b'] });

    expect(drop(LABELS, subject, 'infra', 'bug')).toEqual({
      labelIds: ['bug-b'],
    });
  });

  it('removes whichever label of the group the issue held', () => {
    const subject = issue({ teamId: 'team-b', labelIds: ['bug-workspace'] });

    expect(drop(LABELS, subject, 'bug', NO_GROUP)).toEqual({ labelIds: [] });
  });

  it('writes nothing when the team has no label of that name', () => {
    const subject = issue({ teamId: 'team-a', labelIds: ['bug-workspace'] });

    expect(drop(LABELS, subject, 'bug', 'infra')).toBeUndefined();
  });

  /**
   * The priority board compared a number with the column's id, a string, so
   * every drop wrote, even onto the column the card came from.
   */
  it('writes a priority as a number, and zero for no priority', () => {
    expect(drop(PRIORITIES, issue({ priority: 3 }), '3', '1')).toEqual({
      priority: 1,
    });
    expect(drop(PRIORITIES, issue({ priority: 3 }), '3', NO_GROUP)).toEqual({
      priority: 0,
    });
  });

  it('writes nothing for a grouping a drag cannot change', () => {
    const teams: Grouping = {
      field: 'teamId',
      isArray: false,
      listId: 'team-list',
      readOnly: true,
      groups: [group('team-a'), group('team-b')],
    };

    expect(drop(teams, issue(), 'team-a', 'team-b')).toBeUndefined();
  });

  it('writes nothing onto a column this grouping does not have', () => {
    expect(drop(STATUSES, issue(), 'todo', NO_GROUP)).toBeUndefined();
    expect(drop(STATUSES, issue(), 'todo', 'gone')).toBeUndefined();
  });
});

describe('draggable ids', () => {
  it('carries the column and gives back the issue', () => {
    const id = draggableIdFor('module-server', 'issue-1');

    expect(id).not.toEqual(draggableIdFor('module-webapp', 'issue-1'));
    expect(issueIdOfDraggable(id)).toBe('issue-1');
  });

  it('gives back the issue when the column id has the separator in it', () => {
    expect(issueIdOfDraggable(draggableIdFor('a__b', 'issue-1'))).toBe(
      'issue-1',
    );
  });
});
