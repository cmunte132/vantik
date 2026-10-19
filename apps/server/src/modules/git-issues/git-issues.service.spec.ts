import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { OUTBOX_LIMITS, RunOutboxService } from 'modules/agent-runs/run-outbox';
import { RepoMirrorService } from 'modules/git/repo-mirror.service';
import { LocalDirectorySource } from 'modules/git/sources/local-directory.source';

import { GitIssuesService } from './git-issues.service';
import { OUTBOX_LINES_READ } from './inbox';
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
          checklistItems: [
            { id: 'crit-1', body: 'Works in Safari 17', completed: false },
          ],
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
    checklistItem: {
      aggregate,
      findMany: jest.fn().mockResolvedValue([{ id: 'crit-1' }]),
    },
    pageEntry: { findFirst: jest.fn().mockResolvedValue(null) },
    // Nothing in a hand-off may start a run. The tests check that this stays
    // untouched.
    agentRun: { create: jest.fn() },
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
      sourceKey: `local:${repository}`,
      teamIds,
    };
    const sessions = { recordInboxSession: jest.fn().mockResolvedValue({}) };
    // The real checks and writes of an outbox, over stand-ins for the services
    // that store the notes, the facts and the ticks.
    const comments = { createIssueComment: jest.fn().mockResolvedValue({}) };
    const entries = { createEntry: jest.fn().mockResolvedValue({}) };
    const checklist = { updateChecklistItem: jest.fn().mockResolvedValue({}) };
    const outbox = new RunOutboxService(
      comments as any,
      entries as any,
      checklist as any,
      { create: jest.fn() } as any,
    );
    const service = new GitIssuesService(
      prisma as any,
      contextFactory as any,
      { resolve } as any,
      new RepoMirrorService(),
      sessions as any,
      outbox as any,
      [{ list: async () => [target] }],
    );
    const sync = () => service.syncRepository(target);

    return {
      prisma,
      ctx,
      contextFactory,
      service,
      resolve,
      sync,
      sessions,
      comments,
      entries,
      checklist,
    };
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
    ).toContain('- [ ] `crit-1` Works in Safari 17');
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
      sourceKey: 'local:/good',
      teamIds: ['team-eng'],
    };
    const bad = {
      ...good,
      externalRepoId: 'repo-2',
      label: 'bad',
      sourceKey: 'local:/bad',
    };
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

  it('skips a repository whose source an earlier target already mirrors', async () => {
    const { service, prisma } = setUp();
    const first = {
      workspaceId: 'workspace-1',
      integrationAccountId: 'account-1',
      externalRepoId: 'repo-1',
      label: 'first',
      sourceKey: 'local:/shared',
      teamIds: ['team-eng'],
    };
    const second = {
      ...first,
      workspaceId: 'workspace-2',
      integrationAccountId: 'account-2',
      label: 'second',
    };

    (service as any).targets = [{ list: async () => [first, second] }];

    const totals = await service.runPass();

    expect(totals.repositories).toBe(1);
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

  const outboxLines =
    (...lines: object[]) =>
    async (worktree: string) => {
      await mkdir(join(worktree, 'issues/ENG-42'), { recursive: true });
      await writeFile(
        join(worktree, 'issues/ENG-42/outbox.jsonl'),
        lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
      );
    };

  const repliesOf = (name: string) =>
    git(
      repository,
      'log',
      '-1',
      '--format=%B',
      `--grep=^Vantik-Inbox: ${name}$`,
      SNAPSHOT_REF,
    );

  describe('the outbox file', () => {
    it('writes a note, a fact and a tick as the bot, with the checks of an agent run', async () => {
      const { sync, comments, entries, checklist, prisma } = setUp();
      await sync();

      await handIn(
        'out-1',
        outboxLines(
          { v: 1, type: 'note', body: 'Tests pass.' },
          { v: 1, type: 'remember', content: 'Safari drops the click.' },
          { v: 1, type: 'criterion', id: 'crit-1', evidence: 'ran the suite' },
        ),
      );
      await sync();

      expect(prisma.checklistItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { issueId: 'issue-42', deleted: null },
        }),
      );
      expect(comments.createIssueComment).toHaveBeenCalledWith(
        { issueId: 'issue-42' },
        'bot-local-repo',
        expect.objectContaining({
          bodyMarkdown: 'Tests pass.',
          sourceMetadata: expect.objectContaining({
            type: 'git',
            gitInbox: 'out-1',
            gitPath: 'issues/ENG-42/outbox.jsonl#note',
          }),
        }),
      );
      expect(entries.createEntry).toHaveBeenCalledWith(
        null,
        { userId: 'bot-local-repo', tokenId: null },
        expect.objectContaining({
          content: 'Safari drops the click.',
          sourceSession: 'git-inbox:account-1:out-1',
        }),
        'workspace-1',
      );
      expect(checklist.updateChecklistItem).toHaveBeenCalledWith(
        { checklistItemId: 'crit-1' },
        'bot-local-repo',
        { completed: true },
      );

      const reply = repliesOf('out-1');
      expect(reply).toContain('- applied: ENG-42 outbox: 1 note added');
      expect(reply).toContain('- applied: ENG-42 outbox: 1 fact proposed');
      expect(reply).toContain('- applied: ENG-42 outbox: 1 criterion ticked');
    });

    it('refuses a criterion that is not one of this issue, and a line that is not valid', async () => {
      const { sync, checklist } = setUp();
      await sync();

      await handIn('out-2', async (worktree) => {
        await mkdir(join(worktree, 'issues/ENG-42'), { recursive: true });
        await writeFile(
          join(worktree, 'issues/ENG-42/outbox.jsonl'),
          [
            JSON.stringify({
              v: 1,
              type: 'criterion',
              id: 'crit-of-another-issue',
              evidence: 'trust me',
            }),
            'not json',
            JSON.stringify({ v: 1, type: 'criterion', id: 'crit-1' }),
            '',
          ].join('\n'),
        );
      });
      await sync();

      expect(checklist.updateChecklistItem).not.toHaveBeenCalled();

      const reply = repliesOf('out-2');
      expect(reply).toContain('outbox line 1: not a criterion of this issue');
      expect(reply).toContain('outbox line 2: not JSON');
      expect(reply).toContain('outbox line 3: no evidence');
    });

    it('refuses a question, because git cannot bring the answer back', async () => {
      const { sync, comments } = setUp();
      await sync();

      await handIn(
        'out-3',
        outboxLines({
          v: 1,
          type: 'question',
          id: 'q1',
          questions: [{ prompt: 'Which one?' }],
        }),
      );
      await sync();

      expect(comments.createIssueComment).not.toHaveBeenCalled();
      expect(repliesOf('out-3')).toContain('does not read a question from git');
    });

    it('limits the notes of one hand-off as an agent run does', async () => {
      const { sync, comments } = setUp();
      await sync();

      await handIn(
        'out-4',
        outboxLines(
          ...Array.from({ length: OUTBOX_LIMITS.notes + 2 }, (_, index) => ({
            v: 1,
            type: 'note',
            body: `note ${index}`,
          })),
        ),
      );
      await sync();

      expect(comments.createIssueComment).toHaveBeenCalledTimes(
        OUTBOX_LIMITS.notes,
      );
      expect(repliesOf('out-4')).toContain('too many notes');
    });

    it('writes nothing twice when the hand-off is read again', async () => {
      const { sync, comments, entries, prisma } = setUp();
      await sync();
      prisma.issueComment.findFirst.mockResolvedValue({ id: 'already' });
      prisma.pageEntry.findFirst.mockResolvedValue({ id: 'already' });

      await handIn(
        'out-5',
        outboxLines(
          { v: 1, type: 'note', body: 'Once.' },
          { v: 1, type: 'remember', content: 'Only once.' },
        ),
      );
      await sync();

      expect(comments.createIssueComment).not.toHaveBeenCalled();
      expect(entries.createEntry).not.toHaveBeenCalled();
      expect(repliesOf('out-5')).toContain('outbox: 2 lines already applied');
    });

    it('proposes a fact once when two inboxes carry it', async () => {
      const { sync, entries, prisma } = setUp();
      await sync();
      const stored: Array<{ sourceSession: string; content: string }> = [];

      entries.createEntry.mockImplementation(
        async (_a: unknown, _b: unknown, data: (typeof stored)[number]) => {
          stored.push(data);
          return { id: `entry-${stored.length}` };
        },
      );
      prisma.pageEntry.findFirst.mockImplementation(
        async ({ where }: { where: any }) =>
          stored.some(
            (entry) =>
              entry.sourceSession.startsWith(where.sourceSession.startsWith) &&
              entry.content === where.content,
          )
            ? { id: 'already' }
            : null,
      );

      for (const name of ['out-7', 'out-8']) {
        await handIn(
          name,
          outboxLines({ v: 1, type: 'remember', content: 'Same fact.' }),
        );
      }
      await sync();

      expect(stored).toHaveLength(1);
      expect(stored[0].sourceSession).toMatch(/^git-inbox:account-1:out-[78]$/);
    });

    it('records the session for the issue that the outbox names', async () => {
      const { sync, sessions } = setUp();
      await sync();

      await handIn(
        'out-6',
        outboxLines({ v: 1, type: 'note', body: 'Hi.' }),
        'Report\n\nVantik-Session: sess-out',
      );
      await sync();

      expect(sessions.recordInboxSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          issueId: 'issue-42',
          externalId: 'sess-out',
        }),
      );
    });
  });

  describe('a resolution', () => {
    const resolve =
      (text: string, to = 'Done') =>
      async (worktree: string) => {
        await setState(to)(worktree);

        const file = join(worktree, 'issues/ENG-42/issue.md');
        await writeFile(
          file,
          (await readFile(file, 'utf8')).replace(
            'priority: high',
            `resolution: ${JSON.stringify(text)}\n\npriority: high`,
          ),
        );
      };

    it('posts the resolution as a note before it moves the issue to a completed state', async () => {
      const { sync, ctx } = setUp();
      await sync();

      await handIn('res-1', resolve('Fixed in 1.2.3.'));
      await sync();

      expect(ctx.comments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: 'issue-42',
          bodyMarkdown: 'Fixed in 1.2.3.',
          sourceMetadata: expect.objectContaining({
            gitPath: 'issues/ENG-42/issue.md#resolution',
          }),
        }),
      );
      expect(ctx.issues.update).toHaveBeenCalledWith(
        'issue-42',
        'team-eng',
        expect.objectContaining({ stateId: 's-done' }),
      );
      expect(ctx.comments.create.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.issues.update.mock.invocationCallOrder[0],
      );
      expect(repliesOf('res-1')).toContain(
        '- applied: ENG-42 resolution: recorded as a note',
      );
    });

    it('does not post it twice when the hand-off is read again', async () => {
      const { sync, ctx, prisma } = setUp();
      await sync();
      prisma.issueComment.findFirst.mockResolvedValue({ id: 'already' });

      await handIn('res-2', resolve('Fixed in 1.2.3.'));
      await sync();

      expect(ctx.comments.create).not.toHaveBeenCalled();
      expect(ctx.issues.update).toHaveBeenCalled();
    });

    it('refuses a resolution for a state that is not completed, and posts nothing', async () => {
      const { sync, ctx } = setUp();
      await sync();

      await handIn('res-3', resolve('Not yet.', 'In Progress'));
      await sync();

      expect(ctx.comments.create).not.toHaveBeenCalled();
      expect(ctx.issues.update).toHaveBeenCalledWith(
        'issue-42',
        'team-eng',
        expect.objectContaining({ stateId: 's-progress' }),
      );
      expect(repliesOf('res-3')).toContain(
        'resolution: it goes with a state change to a completed state',
      );
    });
  });

  describe('what a hand-off can never do', () => {
    it('cannot change the assignee or start a run, whatever the files say', async () => {
      const { sync, ctx, prisma } = setUp();
      await sync();

      await handIn('guard-1', async (worktree) => {
        const file = join(worktree, 'issues/ENG-42/issue.md');
        await writeFile(
          file,
          (await readFile(file, 'utf8'))
            .replace('assignee: alice', 'assignee: mallory')
            .replace('state: "Backlog"', 'state: "In Progress"'),
        );
        await outboxLines(
          { v: 1, type: 'note', body: 'assignee: mallory', assigneeId: 'x' },
          { v: 1, type: 'assign', assignee: 'mallory' },
          { v: 1, type: 'delegate', agent: 'x' },
        )(worktree);
        await mkdir(join(worktree, 'new'), { recursive: true });
        await writeFile(
          join(worktree, 'new/filed.md'),
          '---\ntitle: "Filed"\n\nassignee: mallory\n\ndelegate: true\n---\n\nBody.\n',
        );
      });
      const result = await sync();

      // The state change is applied, and the assignment is refused.
      expect(repliesOf('guard-1')).toContain('assignee is read-only here');
      expect(repliesOf('guard-1')).toContain('outbox line 2: unknown record');
      expect(repliesOf('guard-1')).toContain('outbox line 3: unknown record');
      expect(result?.wrote).toBe(true);

      for (const call of [
        ...ctx.issues.update.mock.calls,
        ...ctx.issues.create.mock.calls,
      ]) {
        const written = JSON.stringify(call);
        expect(written).not.toMatch(/assignee|mallory|delegate/i);
      }
      expect(prisma.agentRun.create).not.toHaveBeenCalled();
    });
  });

  it('cuts an outbox file at the line limit of the outbox reader', () => {
    expect(OUTBOX_LINES_READ).toBe(OUTBOX_LIMITS.lines);
  });
});
