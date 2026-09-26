import { parseFrontMatter, readList, readString } from './format';
import { readInbox } from './inbox';
import { renderIssue, type SnapshotIssue } from './snapshot';

const issue: SnapshotIssue = {
  id: 'c0ffee00-0000-4000-8000-000000000042',
  key: 'ENG-42',
  number: 42,
  team: 'ENG',
  title: 'Login: button does nothing on Safari',
  state: 'Backlog',
  stateCategory: 'BACKLOG',
  priority: 2,
  assignee: 'alice',
  labels: ['bug', 'safari'],
  parent: null,
  createdAt: new Date('2026-09-26T16:37:17.000Z'),
  description: 'Repro: open /login in Safari 17.',
  checklist: [],
  comments: [],
};

const before = renderIssue(issue);

describe('the issue file format', () => {
  it('separates fields with blank lines, so edits to neighbours merge', () => {
    expect(before).toContain('state: "Backlog"\n\npriority: high');
  });

  it('reads back what it writes, colon in the title and all', () => {
    const parsed = parseFrontMatter(before);

    expect(readString(parsed?.fields.title)).toBe(issue.title);
    expect(readList(parsed?.fields.labels)).toEqual(['bug', 'safari']);
    expect(parsed?.body).toBe(issue.description);
  });

  it('forgives the quotes a model drops', () => {
    expect(readString('In Progress')).toBe('In Progress');
    expect(readList('[bug, "safari"]')).toEqual(['bug', 'safari']);
    expect(readList('bug, safari')).toEqual(['bug', 'safari']);
  });
});

describe('readInbox', () => {
  const path = 'issues/ENG-42/issue.md';

  it('turns edited fields into from/to changes', () => {
    const after = before
      .replace('state: "Backlog"', 'state: "In Progress"')
      .replace('priority: high', 'priority: urgent')
      .replace('Repro: open', 'Repro, confirmed: open');

    const { proposals, refusals } = readInbox([{ path, before, after }]);

    expect(refusals).toEqual([]);
    expect(proposals).toEqual([
      {
        kind: 'update',
        path,
        key: 'ENG-42',
        issueId: issue.id,
        changes: {
          state: { from: 'Backlog', to: 'In Progress' },
          priority: { from: 'high', to: 'urgent' },
          description: {
            from: 'Repro: open /login in Safari 17.',
            to: 'Repro, confirmed: open /login in Safari 17.',
          },
        },
      },
    ]);
  });

  it('treats labels as a set, so reordering them is no change', () => {
    const after = before.replace('["bug","safari"]', '[safari, bug]');

    expect(readInbox([{ path, before, after }]).proposals).toEqual([]);
  });

  it('refuses read-only fields but keeps the editable ones', () => {
    const after = before
      .replace('assignee: alice', 'assignee: me')
      .replace('priority: high', 'priority: low');

    const { proposals, refusals } = readInbox([{ path, before, after }]);

    expect(proposals).toHaveLength(1);
    expect(refusals[0].reason).toMatch(/assignee is read-only/);
  });

  it('takes a new file under comments/ as a comment, whatever it is named', () => {
    const { proposals } = readInbox([
      {
        path: 'issues/ENG-42/comments/my-note.md',
        before: null,
        after: 'The WebKit submit handler never fires.\n',
      },
    ]);

    expect(proposals).toEqual([
      {
        kind: 'comment',
        path: 'issues/ENG-42/comments/my-note.md',
        key: 'ENG-42',
        body: 'The WebKit submit handler never fires.',
      },
    ]);
  });

  it('refuses editing or deleting a comment that already exists', () => {
    const existing = 'issues/ENG-42/comments/20260926T163717Z--abc.md';
    const { refusals } = readInbox([
      { path: existing, before: 'old', after: 'new' },
      { path: existing.replace('abc', 'def'), before: 'old', after: null },
    ]);

    expect(refusals.map((refusal) => refusal.reason)).toEqual([
      'Comments cannot be edited from git. Add a new one instead.',
      'Comments cannot be deleted from git.',
    ]);
  });

  it('files a new issue from new/', () => {
    const { proposals } = readInbox([
      {
        path: 'new/dark-mode.md',
        before: null,
        after:
          '---\ntitle: Dark mode resets on reload\nteam: ENG\nlabels: [bug]\n---\n\nToggle it, reload.\n',
      },
    ]);

    expect(proposals).toEqual([
      {
        kind: 'create',
        path: 'new/dark-mode.md',
        team: 'ENG',
        title: 'Dark mode resets on reload',
        state: null,
        priority: null,
        labels: ['bug'],
        description: 'Toggle it, reload.',
      },
    ]);
  });

  it('refuses a new issue without a title, and deleting an issue', () => {
    const { refusals } = readInbox([
      { path: 'new/x.md', before: null, after: 'no front matter' },
      { path, before, after: null },
    ]);

    expect(refusals.map((refusal) => refusal.reason)).toEqual([
      'A new issue needs front matter with a title.',
      'Issues cannot be deleted from git. Cancel it in Vantik.',
    ]);
  });

  it('refuses edits to the files Vantik writes and paths it does not read', () => {
    const { refusals } = readInbox([
      { path: 'index.md', before: 'a', after: 'b' },
      { path: 'notes.txt', before: null, after: 'hello' },
    ]);

    expect(refusals.map((refusal) => refusal.path)).toEqual([
      'index.md',
      'notes.txt',
    ]);
  });
});
