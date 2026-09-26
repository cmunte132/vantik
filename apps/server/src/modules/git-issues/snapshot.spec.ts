import { renderSnapshot, type Snapshot, type SnapshotIssue } from './snapshot';

const issue = (title: string): SnapshotIssue => ({
  id: 'issue-1',
  key: 'ENG-1',
  number: 1,
  team: 'ENG',
  title,
  state: 'Backlog',
  stateCategory: 'BACKLOG',
  priority: 0,
  assignee: null,
  labels: [],
  parent: null,
  createdAt: new Date('2026-09-26T00:00:00Z'),
  description: '',
  checklist: [],
  comments: [],
});

const snapshot = (title: string): Snapshot => ({
  teams: [
    {
      identifier: 'ENG',
      name: 'Engineering',
      states: [{ name: 'Backlog', category: 'BACKLOG' }],
    },
  ],
  labels: [],
  issues: [issue(title)],
});

/** The cells of the index row for ENG-1, split on the pipes that are not escaped. */
function row(title: string): string[] {
  const line = (renderSnapshot(snapshot(title)).get('index.md') ?? '')
    .split('\n')
    .find((candidate) => candidate.startsWith('| [ENG-1]'));

  return (line ?? '').split(/(?<!\\)\|/).slice(1, -1);
}

describe('the index table', () => {
  it('keeps a title with a pipe in one cell', () => {
    expect(row('a | b')).toHaveLength(5);
  });

  it('keeps a title ending in a backslash from escaping the next separator', () => {
    const cells = row('Windows path C:\\');

    expect(cells).toHaveLength(5);
    expect(cells[1]).toBe(' Windows path C:\\\\ ');
  });
});
