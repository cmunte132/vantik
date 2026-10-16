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

describe('the checklist file', () => {
  it('names each criterion by its id, so an outbox can tick it', () => {
    const files = renderSnapshot({
      ...snapshot('x'),
      issues: [
        {
          ...issue('x'),
          checklist: [
            { id: 'crit-1', body: 'Works in Safari', completed: false },
            { id: 'crit-2', body: 'Has a test', completed: true },
          ],
        },
      ],
    });
    const checklist = files.get('issues/ENG-1/checklist.md') ?? '';

    expect(checklist).toContain('- [ ] `crit-1` Works in Safari');
    expect(checklist).toContain('- [x] `crit-2` Has a test');
  });

  it('tells the agent how to use the outbox, the resolution and the trailers', () => {
    const readme = renderSnapshot(snapshot('x')).get('README.md') ?? '';

    expect(readme).toContain('issues/<KEY>/outbox.jsonl');
    expect(readme).toContain('resolution: "how it was resolved"');
    expect(readme).toContain('Vantik-Session');
  });
});
