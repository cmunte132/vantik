import { type Lookups, planCreate, planUpdate } from './apply';
import { type CreateProposal, type IssueUpdateProposal } from './inbox';
import { type SnapshotIssue } from './snapshot';

const lookups: Lookups = {
  teams: [
    {
      id: 'team-eng',
      identifier: 'ENG',
      name: 'Engineering',
      states: [
        { id: 's-triage', name: 'Triage', category: 'TRIAGE', position: 0 },
        { id: 's-backlog', name: 'Backlog', category: 'BACKLOG', position: 1 },
        {
          id: 's-progress',
          name: 'In Progress',
          category: 'STARTED',
          position: 2,
        },
        { id: 's-done', name: 'Done', category: 'COMPLETED', position: 3 },
      ],
    },
  ],
  labels: [
    { id: 'l-bug', name: 'bug' },
    { id: 'l-safari', name: 'Safari' },
  ],
};

const current: SnapshotIssue = {
  id: 'issue-42',
  key: 'ENG-42',
  number: 42,
  team: 'ENG',
  title: 'Login broken',
  state: 'Backlog',
  stateCategory: 'BACKLOG',
  priority: 2,
  assignee: null,
  labels: ['bug'],
  parent: null,
  createdAt: new Date('2026-09-26T00:00:00Z'),
  description: 'Repro steps.',
  checklist: [],
  comments: [],
};

function proposal(
  changes: IssueUpdateProposal['changes'],
): IssueUpdateProposal {
  return {
    kind: 'update',
    path: 'issues/ENG-42/issue.md',
    key: 'ENG-42',
    issueId: 'issue-42',
    changes,
  };
}

describe('planUpdate', () => {
  it('applies a change whose starting value still holds', () => {
    const plan = planUpdate(
      current,
      proposal({
        state: { from: 'Backlog', to: 'in progress' },
        priority: { from: 'high', to: 'urgent' },
        labels: { from: ['bug'], to: ['bug', 'safari'] },
      }),
      lookups,
    );

    expect(plan.input).toEqual({
      stateId: 's-progress',
      priority: 1,
      labelIds: ['l-bug', 'l-safari'],
    });
    expect(plan.outcome.refused).toEqual([]);
    expect(plan.outcome.applied).toContain(
      'ENG-42 state: Backlog → In Progress',
    );
  });

  it('refuses a field somebody changed in Vantik after the snapshot, and applies the rest', () => {
    const plan = planUpdate(
      { ...current, state: 'Done', stateCategory: 'COMPLETED' },
      proposal({
        state: { from: 'Backlog', to: 'In Progress' },
        title: { from: 'Login broken', to: 'Login broken on Safari' },
      }),
      lookups,
    );

    expect(plan.input).toEqual({ title: 'Login broken on Safari' });
    expect(plan.outcome.refused).toEqual([
      'ENG-42 state: changed in Vantik to Done after your snapshot, which had Backlog',
    ]);
  });

  it('writes nothing for a field already at the value asked for, so a retry is harmless', () => {
    const plan = planUpdate(
      { ...current, state: 'In Progress' },
      proposal({ state: { from: 'Backlog', to: 'In Progress' } }),
      lookups,
    );

    expect(plan.input).toBeNull();
    expect(plan.outcome.applied).toEqual(['ENG-42 state: already In Progress']);
  });

  it('names the valid values when a state, label or priority is unknown', () => {
    const plan = planUpdate(
      current,
      proposal({
        state: { from: 'Backlog', to: 'Doing' },
        labels: { from: ['bug'], to: ['bug', 'regression'] },
        priority: { from: 'high', to: 'p0' },
      }),
      lookups,
    );

    expect(plan.input).toBeNull();
    expect(plan.outcome.refused).toEqual([
      'ENG-42 state: "Doing" is not a state of ENG. It has "Triage", "Backlog", "In Progress", "Done"',
      'ENG-42 priority: "p0" is not one of none, urgent, high, medium, low',
      'ENG-42 labels: "regression" is not a label in Vantik',
    ]);
  });

  it('refuses a description that changed in Vantik since', () => {
    const plan = planUpdate(
      { ...current, description: 'Edited by a person.' },
      proposal({ description: { from: 'Repro steps.', to: 'Agent text.' } }),
      lookups,
    );

    expect(plan.input).toBeNull();
    expect(plan.outcome.refused[0]).toMatch(/description: changed in Vantik/);
  });
});

describe('planCreate', () => {
  const create: CreateProposal = {
    kind: 'create',
    path: 'new/dark-mode.md',
    team: null,
    title: 'Dark mode resets',
    state: null,
    priority: null,
    labels: null,
    description: 'Steps.',
  };

  it("puts a new issue in the team's triage when it names no state", () => {
    const plan = planCreate(create, lookups);

    expect(plan.teamId).toBe('team-eng');
    expect(plan.input).toEqual({
      title: 'Dark mode resets',
      stateId: 's-triage',
      descriptionMarkdown: 'Steps.',
    });
  });

  it('keeps the issue and drops an unknown label', () => {
    const plan = planCreate({ ...create, labels: ['bug', 'nope'] }, lookups);

    expect(plan.input?.labelIds).toEqual(['l-bug']);
    expect(plan.outcome.refused[0]).toMatch(/"nope" left off/);
  });

  it('refuses a team that is not in the mirror', () => {
    const plan = planCreate({ ...create, team: 'OPS' }, lookups);

    expect(plan.input).toBeNull();
    expect(plan.outcome.refused[0]).toMatch(
      /"OPS" is not a team in this mirror/,
    );
  });

  it('asks for a team when the mirror has more than one', () => {
    const twoTeams: Lookups = {
      ...lookups,
      teams: [
        ...lookups.teams,
        { id: 'team-ops', identifier: 'OPS', name: 'Ops', states: [] },
      ],
    };

    expect(planCreate(create, twoTeams).outcome.refused[0]).toMatch(
      /name a team \(ENG, OPS\)/,
    );
  });
});
