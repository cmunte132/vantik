import { describe, expect, it } from 'vitest';

import type { IssueType } from 'common/types';

import {
  issueInGroup,
  issueInNoGroup,
  moduleIdsAfterDrag,
  NO_GROUP,
  type AxisGrouping,
} from './utils';

/**
 * The second axis groups a list and a board. `GroupingEnum` carried `module`
 * and `capability` before any view read them, so choosing either one grouped
 * the list by status without saying so. These tests hold the rules that the
 * views now use.
 *
 * A module is a list on an issue and a capability is one field, so every rule
 * below has two shapes.
 */

const MODULE_GROUPING: AxisGrouping = {
  kind: 'module',
  property: 'moduleIds',
  isArray: true,
  listId: 'module-list',
  emptyLabel: 'No module',
  groups: [],
};

const CAPABILITY_GROUPING: AxisGrouping = {
  kind: 'capability',
  property: 'capabilityId',
  isArray: false,
  listId: 'capability-list',
  emptyLabel: 'No capability',
  groups: [],
};

function issue(overrides: Partial<IssueType> = {}): IssueType {
  return {
    id: 'issue-1',
    teamId: 'team-1',
    moduleIds: [],
    capabilityId: null,
    ...overrides,
  } as unknown as IssueType;
}

describe('issueInGroup', () => {
  it('puts an issue under the module that it names', () => {
    const subject = issue({ moduleIds: ['module-server'] });

    expect(issueInGroup(subject, MODULE_GROUPING, 'module-server')).toBe(true);
    expect(issueInGroup(subject, MODULE_GROUPING, 'module-webapp')).toBe(false);
  });

  /**
   * An issue can change two modules, and it belongs under both. This is what a
   * label already does, and it is the honest shape: the work is in two places.
   */
  it('puts an issue under each of the modules that it names', () => {
    const subject = issue({ moduleIds: ['module-server', 'module-webapp'] });

    expect(issueInGroup(subject, MODULE_GROUPING, 'module-server')).toBe(true);
    expect(issueInGroup(subject, MODULE_GROUPING, 'module-webapp')).toBe(true);
  });

  it('puts an issue under the one capability that it names', () => {
    const subject = issue({ capabilityId: 'capability-login' });

    expect(issueInGroup(subject, CAPABILITY_GROUPING, 'capability-login')).toBe(
      true,
    );
    expect(
      issueInGroup(subject, CAPABILITY_GROUPING, 'capability-search'),
    ).toBe(false);
  });

  it('reads an issue whose module list was never set', () => {
    const subject = issue({ moduleIds: undefined });

    expect(issueInGroup(subject, MODULE_GROUPING, 'module-server')).toBe(false);
  });
});

describe('issueInNoGroup', () => {
  it('finds an issue that names no module', () => {
    expect(issueInNoGroup(issue(), MODULE_GROUPING)).toBe(true);
    expect(
      issueInNoGroup(issue({ moduleIds: ['module-server'] }), MODULE_GROUPING),
    ).toBe(false);
  });

  it('finds an issue that names no capability', () => {
    expect(issueInNoGroup(issue(), CAPABILITY_GROUPING)).toBe(true);
    expect(
      issueInNoGroup(
        issue({ capabilityId: 'capability-login' }),
        CAPABILITY_GROUPING,
      ),
    ).toBe(false);
  });

  it('reads an issue whose module list was never set', () => {
    expect(
      issueInNoGroup(issue({ moduleIds: undefined }), MODULE_GROUPING),
    ).toBe(true);
  });
});

describe('moduleIdsAfterDrag', () => {
  it('moves an issue from one module to another', () => {
    expect(
      moduleIdsAfterDrag(['module-server'], 'module-server', 'module-webapp'),
    ).toEqual(['module-webapp']);
  });

  it('gives a module to an issue that had none', () => {
    expect(moduleIdsAfterDrag([], NO_GROUP, 'module-server')).toEqual([
      'module-server',
    ]);
  });

  it('takes the module away when the issue goes to the empty column', () => {
    expect(
      moduleIdsAfterDrag(['module-server'], 'module-server', NO_GROUP),
    ).toEqual([]);
  });

  /**
   * A drag says where the issue now belongs. It says nothing about a module
   * that no column in the drag showed, so that module stays.
   */
  it('leaves the other modules of the issue alone', () => {
    expect(
      moduleIdsAfterDrag(
        ['module-server', 'module-shared'],
        'module-server',
        'module-webapp',
      ),
    ).toEqual(['module-shared', 'module-webapp']);
  });

  it('adds no second copy of a module the issue already names', () => {
    expect(
      moduleIdsAfterDrag(
        ['module-server', 'module-webapp'],
        'module-server',
        'module-webapp',
      ),
    ).toEqual(['module-webapp']);
  });

  it('changes nothing when the issue lands where it started', () => {
    expect(
      moduleIdsAfterDrag(['module-server'], 'module-server', 'module-server'),
    ).toEqual(['module-server']);
  });
});

/**
 * A suggestion is not an assignment.
 *
 * The classifier writes `IssueSuggestion.suggestedModuleIds`, and a person
 * accepts it before it reaches `Issue.moduleIds`. Grouping and filtering read
 * the issue and nothing else, so a board never fills with modules that only a
 * fast model believed in. These tests hold that line at the grouping layer.
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

    expect(issueInGroup(subject, MODULE_GROUPING, 'module-server')).toBe(false);
    expect(issueInNoGroup(subject, MODULE_GROUPING)).toBe(true);
  });

  it('groups an issue once the module is assigned', () => {
    const subject = withSuggestion({ moduleIds: ['module-server'] });

    expect(issueInGroup(subject, MODULE_GROUPING, 'module-server')).toBe(true);
    expect(issueInNoGroup(subject, MODULE_GROUPING)).toBe(false);
  });
});
