import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { RepoMirrorService } from 'modules/git/repo-mirror.service';
import { LocalDirectorySource } from 'modules/git/sources/local-directory.source';

import { GitIssuesService } from './git-issues.service';
import { type MirroredRepository } from './mirror-targets';
import { CLOSED_ISSUE_DAYS } from './snapshot';
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
        {
          id: 's-done',
          teamId: 'team-eng',
          name: 'Done',
          category: 'COMPLETED',
          position: 2,
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

// A pass starts many git processes.
jest.setTimeout(60_000);

describe('GitIssuesService', () => {
  let root: string;
  let repository: string;
  const originalRoot = process.env.LOCAL_REPO_ROOT;
  const originalMirrorRoot = process.env.REPO_MIRROR_ROOT;

  beforeEach(async () => {
    root = resolve(await mkdtemp(join(tmpdir(), 'vantik-git-issues-service-')));
    repository = join(root, 'checkout');
    await mkdir(repository);
    git(repository, 'init', '-q', '-b', 'main');
    await writeFile(join(repository, 'app.js'), 'x\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-q', '-m', 'code');
    process.env.LOCAL_REPO_ROOT = root;
    process.env.REPO_MIRROR_ROOT = join(root, 'mirrors');
  });

  afterEach(async () => {
    process.env.LOCAL_REPO_ROOT = originalRoot;
    process.env.REPO_MIRROR_ROOT = originalMirrorRoot;
    await rm(root, { recursive: true, force: true });
  });

  function setUp(teamIds = ['team-eng']) {
    const prisma = buildPrisma();
    const ctx = buildContext();
    const contextFactory = { build: jest.fn().mockReturnValue(ctx) };
    const resolve = jest.fn().mockImplementation(async () => ({
      source: new LocalDirectorySource(),
      repo: {
        workspaceId: 'workspace-1',
        integrationAccountId: 'account-1',
        accountId: '',
        externalRepoId: 'repo-1',
        fullName: 'checkout',
        listing: { id: 'repo-1', path: repository },
        config: {},
      },
    }));
    const target: MirroredRepository = {
      workspaceId: 'workspace-1',
      integrationAccountId: 'account-1',
      externalRepoId: 'repo-1',
      label: repository,
      teamIds,
    };
    const sessions = { recordInboxSession: jest.fn().mockResolvedValue({}) };
    const service = new GitIssuesService(
      prisma as any,
      contextFactory as any,
      { resolve } as any,
      new RepoMirrorService(),
      sessions as any,
      [{ list: async () => [target] }],
    );
    const sync = () => service.syncRepository(target);

    return { prisma, ctx, contextFactory, service, resolve, sync, sessions };
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

  /** What an agent does: a commit on the snapshot and an inbox ref. */
  async function handOff(
    name: string,
    edit: (worktree: string) => Promise<void>,
  ) {
    const worktree = join(root, `agent-${name}`);

    git(
      repository,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      SNAPSHOT_REF,
    );
    await edit(worktree);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'proposal');
    git(worktree, 'update-ref', `${INBOX_PREFIX}${name}`, 'HEAD');
  }

  it('finds an earlier comment by its path and content, not by its commit', async () => {
    const { prisma, ctx, sync } = setUp();
    await sync();

    await handOff('again', async (worktree) => {
      await mkdir(join(worktree, 'issues/ENG-42/comments'), {
        recursive: true,
      });
      await writeFile(
        join(worktree, 'issues/ENG-42/comments/note.md'),
        'Once.\n',
      );
    });

    await sync();

    const { where } = prisma.issueComment.findFirst.mock.calls[0][0];
    const keys = where.AND.map(
      (condition: any) => condition.sourceMetadata.path[0],
    );

    expect(where.issueId).toBe('issue-42');
    expect(keys).toEqual(['gitPath', 'gitContentHash']);
    expect(JSON.stringify(where)).not.toContain('gitCommit');
    expect(ctx.comments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMetadata: expect.objectContaining({
          gitPath: 'issues/ENG-42/comments/note.md',
          gitContentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
    );
  });

  it('clears a description that an agent emptied', async () => {
    const { ctx, sync } = setUp();
    await sync();

    await handOff('clear', async (worktree) => {
      const file = join(worktree, 'issues/ENG-42/issue.md');
      const text = await readFile(file, 'utf8');
      const body = text.indexOf('Repro: open');

      await writeFile(file, text.slice(0, body));
    });

    const result = await sync();

    expect(ctx.issues.update).toHaveBeenCalledWith(
      'issue-42',
      'team-eng',
      expect.objectContaining({ descriptionMarkdown: '' }),
    );
    expect(
      result?.handOffs[0].outcomes.flatMap((outcome) => outcome.applied),
    ).toEqual(['ENG-42 description: updated']);
  });

  it('leaves closed issues older than the limit out of the snapshot', async () => {
    const { prisma, sync } = setUp();
    const before = Date.now();

    await sync();

    const { where } = prisma.issue.findMany.mock.calls[0][0];
    const [open, recent] = where.OR;

    expect(open).toEqual({ stateId: { notIn: ['s-done'] } });
    const expected = before - CLOSED_ISSUE_DAYS * 24 * 60 * 60 * 1000;

    expect(
      Math.abs(recent.stateEnteredAt.gte.getTime() - expected),
    ).toBeLessThan(60_000);
  });

  it('refuses two teams that share an identifier', async () => {
    const { prisma, sync } = setUp(['team-eng', 'team-eng-2']);
    prisma.team.findMany.mockResolvedValue([
      { id: 'team-eng', identifier: 'ENG', name: 'Engineering' },
      { id: 'team-eng-2', identifier: 'ENG', name: 'Engineering two' },
    ]);

    await expect(sync()).rejects.toThrow(/more than one mirrored team.*ENG/);
  });

  it('stops when the source no longer offers the repository', async () => {
    const { resolve, sync } = setUp();
    resolve.mockResolvedValue({ unresolved: 'the repository is gone' });

    await expect(sync()).rejects.toThrow('the repository is gone');
  });

  it('runs every repository that a tier lists, and survives one that fails', async () => {
    const { service, resolve, prisma } = setUp();
    const good = {
      workspaceId: 'workspace-1',
      integrationAccountId: 'account-1',
      externalRepoId: 'repo-1',
      label: 'good',
      teamIds: ['team-eng'],
    };
    const bad = { ...good, externalRepoId: 'repo-2', label: 'bad' };
    const resolveGood = resolve.getMockImplementation()!;

    resolve.mockImplementation(async (ref: { externalRepoId: string }) =>
      ref.externalRepoId === 'repo-2'
        ? { unresolved: 'gone' }
        : await resolveGood(),
    );
    (service as any).targets = [{ list: async () => [bad, good] }];

    const totals = await service.runPass();

    expect(totals).toEqual({ repositories: 2, wrote: 1, handOffs: 0 });
    expect(prisma.team.findMany).toHaveBeenCalledTimes(1);
  });

  /** What an agent does: edit the snapshot, commit, and name an inbox. */
  async function handIn(
    name: string,
    edit: (worktree: string) => Promise<void>,
    message = `proposal ${name}`,
  ) {
    const worktree = join(root, `agent-${name}`);

    git(
      repository,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      SNAPSHOT_REF,
    );
    await edit(worktree);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', message);
    git(worktree, 'update-ref', `${INBOX_PREFIX}${name}`, 'HEAD');
    git(repository, 'worktree', 'remove', '--force', worktree);
  }

  const addComment =
    (text = 'Found it.\n') =>
    async (worktree: string) => {
      await mkdir(join(worktree, 'issues/ENG-42/comments'), {
        recursive: true,
      });
      await writeFile(join(worktree, 'issues/ENG-42/comments/note.md'), text);
    };

  const setState = (to: string) => async (worktree: string) => {
    const file = join(worktree, 'issues/ENG-42/issue.md');

    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        'state: "Backlog"',
        `state: "${to}"`,
      ),
    );
  };

  describe('sessions', () => {
    it('records the session that the trailers name, as the bot, for the issue it touched', async () => {
      const { sync, sessions } = setUp();
      await sync();

      await handIn(
        'run-1',
        addComment(),
        'Report\n\nVantik-Session: sess-9\nVantik-Harness: pi',
      );
      await sync();

      expect(sessions.recordInboxSession).toHaveBeenCalledTimes(1);
      expect(sessions.recordInboxSession).toHaveBeenCalledWith(
        { workspaceId: 'workspace-1', userId: 'bot-local-repo' },
        { issueId: 'issue-42', externalId: 'sess-9', harness: 'pi' },
      );
    });

    it('records one session for an issue that the hand-off changed twice', async () => {
      const { sync, sessions } = setUp();
      await sync();

      await handIn(
        'run-2',
        async (worktree) => {
          await addComment()(worktree);
          await setState('In Progress')(worktree);
        },
        'Report\n\nVantik-Session: sess-9',
      );
      await sync();

      expect(sessions.recordInboxSession).toHaveBeenCalledTimes(1);
    });

    it('makes no session when the commits have no trailer', async () => {
      const { sync, sessions } = setUp();
      await sync();

      await handIn('run-3', addComment());
      await sync();

      expect(sessions.recordInboxSession).not.toHaveBeenCalled();
    });

    it('makes no session when the session names no issue that the hand-off touched', async () => {
      const { sync, sessions, prisma } = setUp();
      await sync();
      prisma.issue.findFirst.mockResolvedValue(null);

      await handIn('run-4', addComment(), 'Report\n\nVantik-Session: sess-9');
      await sync();

      expect(sessions.recordInboxSession).not.toHaveBeenCalled();
    });

    it('still applies the hand-off when the session cannot be recorded', async () => {
      const { sync, sessions, ctx } = setUp();
      await sync();
      sessions.recordInboxSession.mockRejectedValue(new Error('database down'));

      await handIn('run-5', addComment(), 'Report\n\nVantik-Session: sess-9');
      const result = await sync();

      expect(ctx.comments.create).toHaveBeenCalled();
      expect(result?.wrote).toBe(true);
    });
  });
});
