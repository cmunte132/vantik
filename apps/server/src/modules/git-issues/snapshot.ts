import {
  commentFilename,
  priorityName,
  PRIORITY_NAMES,
  quoted,
  renderFrontMatter,
} from './format';

/**
 * What one repository's mirror holds, already resolved to names.
 *
 * The render is a pure function of this, so the same database state always
 * gives the same bytes, and a pass that finds nothing new writes no commit.
 * Nothing time-dependent goes in: no "generated at", no `updatedAt`, which
 * moves when an issue is merely re-sorted.
 */
export interface SnapshotState {
  name: string;
  category: string;
}

export interface SnapshotTeam {
  identifier: string;
  name: string;
  /** In the team's workflow order. */
  states: SnapshotState[];
}

export interface SnapshotComment {
  id: string;
  author: string;
  createdAt: Date;
  replyTo: string | null;
  /** Markdown. */
  body: string;
}

export interface SnapshotIssue {
  id: string;
  key: string;
  number: number;
  team: string;
  title: string;
  state: string;
  stateCategory: string;
  priority: number | null;
  assignee: string | null;
  labels: string[];
  parent: string | null;
  createdAt: Date;
  /** Markdown. */
  description: string;
  checklist: Array<{ body: string; completed: boolean }>;
  comments: SnapshotComment[];
}

export interface Snapshot {
  teams: SnapshotTeam[];
  labels: string[];
  issues: SnapshotIssue[];
}

export const CLOSED_CATEGORIES = ['COMPLETED', 'CANCELED'];

const OPEN_CATEGORY_ORDER = ['STARTED', 'UNSTARTED', 'BACKLOG', 'TRIAGE'];

export function issueDirectory(key: string): string {
  return `issues/${key}`;
}

/** Every file of the mirror, by path. */
export function renderSnapshot(snapshot: Snapshot): Map<string, string> {
  const files = new Map<string, string>();

  files.set('README.md', renderReadme(snapshot));
  files.set('index.md', renderIndex(snapshot));

  for (const issue of snapshot.issues) {
    const directory = issueDirectory(issue.key);

    files.set(`${directory}/issue.md`, renderIssue(issue));

    if (issue.checklist.length > 0) {
      files.set(`${directory}/checklist.md`, renderChecklist(issue));
    }

    for (const comment of issue.comments) {
      files.set(
        `${directory}/comments/${commentFilename(comment.createdAt, comment.id)}`,
        renderComment(comment),
      );
    }
  }

  return files;
}

export function renderIssue(issue: SnapshotIssue): string {
  return renderFrontMatter(
    [
      ['id', issue.id],
      ['key', issue.key],
      ['team', issue.team],
      ['title', quoted(issue.title)],
      ['state', quoted(issue.state)],
      ['priority', priorityName(issue.priority)],
      ['labels', [...issue.labels].sort()],
      ['assignee', issue.assignee],
      ['parent', issue.parent],
      ['created', issue.createdAt.toISOString()],
    ],
    issue.description,
  );
}

function renderComment(comment: SnapshotComment): string {
  return renderFrontMatter(
    [
      ['author', quoted(comment.author)],
      ['created', comment.createdAt.toISOString()],
      ['reply-to', comment.replyTo],
    ],
    comment.body,
  );
}

function renderChecklist(issue: SnapshotIssue): string {
  const items = issue.checklist.map(
    (item) =>
      `- [${item.completed ? 'x' : ' '}] ${item.body.replace(/\s*\n\s*/g, ' ')}`,
  );

  return [
    `# ${issue.key}: definition of done`,
    '',
    'Read-only here. Tick items in Vantik.',
    '',
    ...items,
    '',
  ].join('\n');
}

function renderIndex(snapshot: Snapshot): string {
  const lines = [
    '# Open issues',
    '',
    'A copy of Vantik, rewritten from it about once a minute. README.md says',
    'how to propose a change.',
  ];

  for (const team of snapshot.teams) {
    const issues = snapshot.issues.filter(
      (issue) => issue.team === team.identifier,
    );
    const open = issues
      .filter((issue) => !CLOSED_CATEGORIES.includes(issue.stateCategory))
      .sort(compareOpenIssues);
    const closed = issues.length - open.length;

    lines.push('', `## ${team.identifier}: ${team.name}`, '');

    if (open.length === 0) {
      lines.push('No open issues.');
    } else {
      lines.push(
        '| Key | Title | State | Priority | Assignee |',
        '| --- | --- | --- | --- | --- |',
        ...open.map(
          (issue) =>
            `| [${issue.key}](${issueDirectory(issue.key)}/issue.md) | ${cell(issue.title)} | ${cell(issue.state)} | ${priorityName(issue.priority)} | ${cell(issue.assignee ?? '')} |`,
        ),
      );
    }

    if (closed > 0) {
      lines.push(
        '',
        `${closed} closed ${closed === 1 ? 'issue is' : 'issues are'} not listed, and ${closed === 1 ? 'is' : 'are'} still under issues/.`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function compareOpenIssues(a: SnapshotIssue, b: SnapshotIssue): number {
  const category =
    OPEN_CATEGORY_ORDER.indexOf(a.stateCategory) -
    OPEN_CATEGORY_ORDER.indexOf(b.stateCategory);

  if (category !== 0) {
    return category;
  }

  // Urgent first and "none" last, which is not the numeric order.
  const rank = (priority: number | null) => (priority ? priority : 5);
  const priority = rank(a.priority) - rank(b.priority);

  return priority !== 0 ? priority : a.number - b.number;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/**
 * The instructions an agent reads before it touches anything.
 *
 * They live in the ref rather than only in the docs because the reader is an
 * agent that can reach this repository and, by assumption, not much else.
 */
function renderReadme(snapshot: Snapshot): string {
  const multipleTeams = snapshot.teams.length > 1;

  return [
    '# Vantik issues',
    '',
    'Vantik writes this ref from its database, about once a minute. The',
    'database is the source of truth; this is a copy for agents that can reach',
    'this repository but not Vantik. Never commit to `refs/vantik/issues`',
    'itself: Vantik owns it, and its next pass replaces what you wrote.',
    '',
    '## Reading',
    '',
    '- `index.md`: the open issues of each team.',
    '- `issues/<KEY>/issue.md`: one issue. Front matter, then the description.',
    '- `issues/<KEY>/checklist.md`: its definition of done, when it has one.',
    '- `issues/<KEY>/comments/`: its comments, oldest first.',
    '',
    'Without checking anything out:',
    '',
    '```',
    'git show refs/vantik/issues:index.md',
    'git show refs/vantik/issues:issues/ENG-42/issue.md',
    '```',
    '',
    'In a clone of the repository that Vantik writes to, fetch the ref first:',
    '',
    '```',
    "git config --add remote.origin.fetch '+refs/vantik/issues:refs/vantik/issues'",
    'git fetch origin',
    '```',
    '',
    '## Proposing a change',
    '',
    '1. Check the snapshot out somewhere of your own:',
    '   `git worktree add --detach /tmp/vantik-issues refs/vantik/issues`',
    '2. Edit files as described below, and commit.',
    '3. Hand the commit to Vantik under a name nobody else will use, such as',
    '   your session id. Use a new name for every hand-off.',
    '   - In the repository Vantik writes to: `git update-ref refs/vantik/inbox/<name> HEAD`',
    '   - From a clone of it: `git push origin HEAD:refs/vantik/inbox/<name>`',
    '4. On its next pass Vantik applies what it can, deletes the inbox ref, and',
    '   records the outcome in the message of the next snapshot commit:',
    "   `git log refs/vantik/issues -1 --grep='^Vantik-Inbox: <name>$'`",
    '',
    'What you can change:',
    '',
    '- In `issue.md`: `title`, `state`, `priority`, `labels`, and the',
    '  description after the front matter.',
    '- A new comment: add a file under `issues/<KEY>/comments/`, with any name',
    '  ending in `.md`. Its content is the comment, in Markdown.',
    '- A new issue: add a file under `new/`, such as `new/login-timeout.md`.',
    `  Front matter needs \`title\`${multipleTeams ? ' and `team`' : ''}; \`state\`, \`priority\``,
    '  and `labels` are optional. The description goes after it. New issues',
    "  start in the team's triage or backlog state unless you name one.",
    '',
    'Vantik refuses, and says why in the outcome:',
    '',
    '- any other field (`id`, `key`, `team`, `assignee`, `parent`, `created`);',
    '- editing or deleting a comment, deleting an issue, and any other path;',
    '- a change to a field that somebody changed in Vantik after the snapshot',
    '  you started from. Start again from the current snapshot.',
    '',
    'Everything you write is a proposal from whoever authored the commit. Vantik',
    'records it that way; the commit author is not checked against its users.',
    '',
    '## Values',
    '',
    `- \`priority\`: ${PRIORITY_NAMES.join(', ')}`,
    `- \`labels\`: ${snapshot.labels.length > 0 ? snapshot.labels.map((label) => `\`${label}\``).join(', ') : 'none defined yet'}. Unknown labels are refused; create them in Vantik.`,
    ...snapshot.teams.map(
      (team) =>
        `- \`state\` for ${team.identifier} (${team.name}): ${team.states.map((state) => quoted(state.name)).join(', ')}`,
    ),
    '',
  ].join('\n');
}
