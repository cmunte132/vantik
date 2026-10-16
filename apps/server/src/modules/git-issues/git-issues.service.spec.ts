import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { GitIssuesService } from './git-issues.service';
import { INBOX_PREFIX, SNAPSHOT_REF } from './sync';

/**
 * The Vantik half of the mirror: what it reads from the database, and what it
 * writes back through the plugin context when an agent hands something in.
 * The repository is real and the database is not.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const description = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Repro: open ' },
        { type: 'text', text: '/login', marks: [{ type: 'code' }] },
      ],
    },
  ],
});

const issueRow = {
  id: 'issue-42',
  number: 42,
  title: 'Login broken on Safari',
  description,
  priority: 2,
  stateId: 's-backlog',
  assigneeId: 'user-alice',
  labelIds: ['l-bug'],
  parentId: null as string | null,
  teamId: 'team-eng',
  createdAt: new Date('2026-09-26T10:00:00Z'),
};

function buildPrisma() {
  const aggregate = jest.fn().mockResolvedValue({ _max: {}, _count: 1 });

  return {
    team: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'team-eng', identifier: 'ENG', name: 'Engineering' },
        ]),
      aggregate,
    },
    workflow: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 's-backlog',
          teamId: 'team-eng',
          name: 'Backlog',
          category: 'BACKLOG',
          position: 0,
        },
        {
          id: 's-progress',
          teamId: 'team-eng',
          name: 'In Progress',
          category: 'STARTED',
          position: 1,
        },
      ]),
      aggregate,
    },
    label: {
      findMany: jest.fn().mockResolvedValue([{ id: 'l-bug', name: 'bug' }]),
      aggregate,
    },
    issue: {
      findMany: jest.fn().mockResolvedValue([
        {
          ...issueRow,
          checklistItems: [{ body: 'Works in Safari 17', completed: false }],
          comments: [],
        },
      ]),
      findFirst: jest
        .fn()
        .mockImplementation((args: any) =>
          args.where.id === 'issue-42' || args.where.number === 42
            ? { ...issueRow }
            : null,
        ),
      aggregate,
    },
    issueComment: {
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate,
    },
    checklistItem: { aggregate },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'user-alice', username: 'alice' }]),
      aggregate,
      upsert: jest.fn().mockResolvedValue({ id: 'bot-local-repo' }),
    },
    usersOnWorkspaces: {
      findUnique: jest.fn().mockResolvedValue({ role: 'BOT' }),
    },
    integrationDefinitionV2: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ name: 'Local repository', icon: 'local-repo' }),
    },
  };
}

function buildContext() {
  return {
    issues: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ number: 43 }),
    },
    comments: { create: jest.fn().mockResolvedValue({}) },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Agent Smith',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent Smith',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
    },
  }).trim();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('GitIssuesService', () => {
  let root: string;
  let repository: string;
  const originalRoot = process.env.LOCAL_REPO_ROOT;

  beforeEach(async () => {
    root = resolve(await mkdtemp(join(tmpdir(), 'vantik-git-issues-service-')));
    repository = join(root, 'checkout');
    await mkdir(repository);
    git(repository, 'init', '-q', '-b', 'main');
    await writeFile(join(repository, 'app.js'), 'x\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-q', '-m', 'code');
    process.env.LOCAL_REPO_ROOT = root;
  });

  afterEach(async () => {
    process.env.LOCAL_REPO_ROOT = originalRoot;
    await rm(root, { recursive: true, force: true });
  });

  function setUp() {
    const prisma = buildPrisma();
    const ctx = buildContext();
    const contextFactory = { build: jest.fn().mockReturnValue(ctx) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new GitIssuesService(prisma as any, contextFactory as any);
    const sync = () =>
      service.syncLocalRepository('workspace-1', 'account-1', {
        id: 'repo-1',
        fullName: 'checkout',
        path: repository,
        addedAt: '2026-09-26T00:00:00Z',
        gitIssues: { teamIds: ['team-eng'] },
      });

    return { prisma, ctx, contextFactory, sync };
  }

  it('renders issues by name: key, state, username, label, markdown', async () => {
    const { sync } = setUp();

    await sync();

    const file = git(
      repository,
      'show',
      `${SNAPSHOT_REF}:issues/ENG-42/issue.md`,
    );
    expect(file).toContain('state: "Backlog"');
    expect(file).toContain('assignee: alice');
    expect(file).toContain('labels: ["bug"]');
    expect(file).toContain('Repro: open `/login`');
    expect(
      git(repository, 'show', `${SNAPSHOT_REF}:issues/ENG-42/checklist.md`),
    ).toContain('- [ ] Works in Safari 17');
  });

  it('writes an agent hand-off as the local-repo bot, naming the commit author', async () => {
    const { ctx, contextFactory, sync } = setUp();
    await sync();

    const worktree = join(root, 'agent');
    git(
      repository,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      SNAPSHOT_REF,
    );
    const file = join(worktree, 'issues/ENG-42/issue.md');
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        'state: "Backlog"',
        'state: "In Progress"',
      ),
    );
    await mkdir(join(worktree, 'issues/ENG-42/comments'), { recursive: true });
    await writeFile(
      join(worktree, 'issues/ENG-42/comments/note.md'),
      'Found it.\n',
    );
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'proposal');
    git(worktree, 'update-ref', `${INBOX_PREFIX}run-7`, 'HEAD');

    const result = await sync();

    expect(contextFactory.build).toHaveBeenCalledWith(
      'local-repo',
      'workspace-1',
      'bot-local-repo',
    );
    expect(ctx.issues.update).toHaveBeenCalledWith(
      'issue-42',
      'team-eng',
      expect.objectContaining({
        stateId: 's-progress',
        sourceMetadata: expect.objectContaining({
          type: 'git',
          userDisplayName: 'Agent Smith',
          gitInbox: 'run-7',
        }),
      }),
    );
    expect(ctx.comments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: 'issue-42',
        bodyMarkdown: 'Found it.',
        sourceMetadata: expect.objectContaining({
          gitPath: 'issues/ENG-42/comments/note.md',
        }),
      }),
    );
    // In path order, which is the order git lists the changed files in.
    expect(
      result?.handOffs[0].outcomes.flatMap((outcome) => outcome.applied),
    ).toEqual(['ENG-42 comment added', 'ENG-42 state: Backlog → In Progress']);
  });

  it('does not add a comment twice when a hand-off is read again', async () => {
    const { prisma, ctx, sync } = setUp();
    await sync();

    const worktree = join(root, 'agent');
    git(
      repository,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      SNAPSHOT_REF,
    );
    await mkdir(join(worktree, 'issues/ENG-42/comments'), { recursive: true });
    await writeFile(
      join(worktree, 'issues/ENG-42/comments/note.md'),
      'Once.\n',
    );
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'proposal');
    git(worktree, 'update-ref', `${INBOX_PREFIX}again`, 'HEAD');
    prisma.issueComment.findFirst.mockResolvedValue({ id: 'already-there' });

    const result = await sync();

    expect(ctx.comments.create).not.toHaveBeenCalled();
    expect(result?.handOffs[0].outcomes[0].applied).toEqual([
      'ENG-42 comment already added',
    ]);
  });

  it('skips the render when nothing in the database or the ref has moved', async () => {
    const { prisma, sync } = setUp();

    await sync();
    await sync();

    // Once for the first render; the second pass stops at the marker.
    expect(prisma.issue.findMany).toHaveBeenCalledTimes(1);
  });
});
