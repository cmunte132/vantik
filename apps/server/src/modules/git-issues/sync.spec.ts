import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { type Lookups, type Outcome, planCreate, planUpdate } from './apply';
import { GitRepository } from './git';
import { type InboxReading } from './inbox';
import { type Snapshot, type SnapshotIssue } from './snapshot';
import {
  type HandOffSource,
  INBOX_PREFIX,
  type MirrorStore,
  SNAPSHOT_REF,
  syncRepository,
} from './sync';

/**
 * The mirror against real repositories, because what is being tested is what
 * git does: which refs move, what a plain clone sees, whether a checkout is
 * disturbed. The store is an in-memory stand-in for the database that applies
 * proposals with the same planning rules the service uses.
 */

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
      ],
    },
  ],
  labels: [{ id: 'l-bug', name: 'bug' }],
};

class MemoryStore implements MirrorStore {
  issues: SnapshotIssue[] = [
    {
      id: 'issue-1',
      key: 'ENG-1',
      number: 1,
      team: 'ENG',
      title: 'Login broken on Safari',
      state: 'Backlog',
      stateCategory: 'BACKLOG',
      priority: 2,
      assignee: null,
      labels: [],
      parent: null,
      createdAt: new Date('2026-09-26T10:00:00Z'),
      description: 'Repro: open /login.',
      checklist: [],
      comments: [],
    },
  ];

  async load(): Promise<Snapshot> {
    return {
      teams: [
        {
          identifier: 'ENG',
          name: 'Engineering',
          states: lookups.teams[0].states,
        },
      ],
      labels: ['bug'],
      issues: this.issues,
    };
  }

  async apply(
    reading: InboxReading,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _source?: HandOffSource,
  ): Promise<Outcome[]> {
    return reading.proposals.map((proposal) => {
      if (proposal.kind === 'update') {
        const issue = this.issues.find((item) => item.id === proposal.issueId)!;
        const plan = planUpdate(issue, proposal, lookups);
        const state = lookups.teams[0].states.find(
          (item) => item.id === plan.input?.stateId,
        );

        if (state) {
          issue.state = state.name;
          issue.stateCategory = state.category;
        }
        if (plan.input?.priority !== undefined) {
          issue.priority = plan.input.priority;
        }

        return plan.outcome;
      }

      if (proposal.kind === 'comment') {
        const issue = this.issues.find((item) => item.key === proposal.key)!;
        issue.comments.push({
          id: `comment-${issue.comments.length + 1}`,
          author: 'agent via git',
          createdAt: new Date('2026-09-26T11:00:00Z'),
          replyTo: null,
          body: proposal.body,
        });
        return { path: proposal.path, applied: ['comment added'], refused: [] };
      }

      const plan = planCreate(proposal, lookups);
      const number = this.issues.length + 1;
      this.issues.push({
        ...this.issues[0],
        id: `issue-${number}`,
        key: `ENG-${number}`,
        number,
        title: plan.input!.title,
        state: 'Triage',
        stateCategory: 'TRIAGE',
        description: plan.input!.descriptionMarkdown ?? '',
        comments: [],
      });
      return plan.outcome;
    });
  }
}

let root: string;

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

async function checkout(): Promise<string> {
  const path = await mkdtemp(join(root, 'checkout-'));

  git(path, 'init', '-q', '-b', 'main');
  await writeFile(join(path, 'app.js'), 'console.log(1);\n');
  git(path, 'add', 'app.js');
  git(path, 'commit', '-q', '-m', 'code');

  return path;
}

/** What an agent does, with plain git and nothing else. */
async function handOff(
  repository: string,
  name: string,
  edit: (worktree: string) => Promise<void>,
) {
  const worktree = join(root, `worktree-${name}`);

  git(repository, 'worktree', 'add', '-q', '--detach', worktree, SNAPSHOT_REF);
  await edit(worktree);
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', `proposal ${name}`);
  git(worktree, 'update-ref', `${INBOX_PREFIX}${name}`, 'HEAD');
  git(repository, 'worktree', 'remove', '--force', worktree);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vantik-git-issues-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('syncRepository', () => {
  it('writes the snapshot without touching HEAD, the index or the working tree', async () => {
    const repository = await checkout();
    const head = git(repository, 'rev-parse', 'HEAD');

    // A dirty working tree and a staged change that must both survive.
    await writeFile(join(repository, 'app.js'), 'console.log(2);\n');
    await writeFile(join(repository, 'staged.js'), 'x\n');
    git(repository, 'add', 'staged.js');
    const status = git(repository, 'status', '--porcelain');

    const result = await syncRepository(
      new GitRepository(repository),
      new MemoryStore(),
    );

    expect(result.wrote).toBe(true);
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repository, 'status', '--porcelain')).toBe(status);
    expect(git(repository, 'branch', '--list')).toBe('* main');
    expect(
      git(repository, 'show', `${SNAPSHOT_REF}:issues/ENG-1/issue.md`),
    ).toContain('title: "Login broken on Safari"');
    expect(
      git(repository, 'log', '-1', '--format=%an <%ae>', SNAPSHOT_REF),
    ).toBe('Vantik <vantik@vantik.local>');
  });

  it('writes no commit when nothing changed', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    const first = await syncRepository(new GitRepository(repository), store);
    const second = await syncRepository(new GitRepository(repository), store);

    expect(second.wrote).toBe(false);
    expect(second.tip).toBe(first.tip);
  });

  it('applies an inbox, deletes it, and answers in the next snapshot', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await syncRepository(new GitRepository(repository), store);

    await handOff(repository, 'session-1', async (worktree) => {
      const file = join(worktree, 'issues/ENG-1/issue.md');
      const text = await readFile(file, 'utf8');
      await writeFile(
        file,
        text.replace('state: "Backlog"', 'state: "In Progress"'),
      );
      await mkdir(join(worktree, 'issues/ENG-1/comments'), { recursive: true });
      await writeFile(
        join(worktree, 'issues/ENG-1/comments/note.md'),
        'The submit handler never fires.\n',
      );
    });

    const result = await syncRepository(new GitRepository(repository), store);

    expect(result.handOffs.map((handOff) => handOff.name)).toEqual([
      'session-1',
    ]);
    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toBe('');
    expect(
      git(repository, 'show', `${SNAPSHOT_REF}:issues/ENG-1/issue.md`),
    ).toContain('state: "In Progress"');
    expect(
      git(
        repository,
        'ls-tree',
        '--name-only',
        `${SNAPSHOT_REF}:issues/ENG-1/comments`,
      ),
    ).toMatch(/--comment-1\.md$/);

    const reply = git(
      repository,
      'log',
      '-1',
      '--format=%B',
      '--grep=^Vantik-Inbox: session-1$',
      SNAPSHOT_REF,
    );
    expect(reply).toContain('by Agent Smith <agent@example.com>');
    expect(reply).toContain('- applied: ENG-1 state: Backlog → In Progress');
    expect(reply).toContain('- applied: comment added');
  });

  it('applies two agents working on the same issue at once', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await syncRepository(new GitRepository(repository), store);

    const edit = (from: string, to: string) => async (worktree: string) => {
      const file = join(worktree, 'issues/ENG-1/issue.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
    };

    await handOff(
      repository,
      'a',
      edit('state: "Backlog"', 'state: "In Progress"'),
    );
    await handOff(repository, 'b', edit('priority: high', 'priority: urgent'));

    await syncRepository(new GitRepository(repository), store);

    expect(store.issues[0]).toMatchObject({
      state: 'In Progress',
      priority: 1,
    });
  });

  it('refuses an inbox that is not built on the snapshot', async () => {
    const repository = await checkout();
    await syncRepository(new GitRepository(repository), new MemoryStore());
    git(repository, 'update-ref', `${INBOX_PREFIX}stray`, 'HEAD');

    const result = await syncRepository(
      new GitRepository(repository),
      new MemoryStore(),
    );

    expect(result.handOffs[0].outcomes[0].refused[0]).toMatch(
      /not built on refs\/vantik\/issues/,
    );
    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toBe('');
  });

  it('files a new issue from new/', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await syncRepository(new GitRepository(repository), store);

    await handOff(repository, 'filing', async (worktree) => {
      await mkdir(join(worktree, 'new'));
      await writeFile(
        join(worktree, 'new/dark-mode.md'),
        '---\ntitle: Dark mode resets on reload\n---\n\nToggle, reload.\n',
      );
    });

    await syncRepository(new GitRepository(repository), store);

    expect(git(repository, 'show', `${SNAPSHOT_REF}:index.md`)).toContain(
      'Dark mode resets on reload',
    );
    expect(
      git(repository, 'ls-tree', '--name-only', SNAPSHOT_REF),
    ).not.toContain('new');
  });

  it('reads commits made on the snapshot ref itself, and keeps them in history', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await syncRepository(new GitRepository(repository), store);

    const worktree = join(root, 'direct');
    git(
      repository,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      SNAPSHOT_REF,
    );
    const file = join(worktree, 'issues/ENG-1/issue.md');
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace('priority: high', 'priority: low'),
    );
    git(worktree, 'commit', '-q', '-am', 'direct edit');
    const direct = git(worktree, 'rev-parse', 'HEAD');
    git(worktree, 'update-ref', SNAPSHOT_REF, 'HEAD');

    const result = await syncRepository(new GitRepository(repository), store);

    expect(result.handOffs.map((handOff) => handOff.name)).toEqual(['direct']);
    expect(store.issues[0].priority).toBe(4);
    expect(git(repository, 'rev-parse', `${SNAPSHOT_REF}^`)).toBe(direct);
  });

  it('never runs a hook from the checkout', async () => {
    const repository = await checkout();
    const marker = join(root, 'hook-ran');
    const hook = join(repository, '.git/hooks/reference-transaction');

    await writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await syncRepository(new GitRepository(repository), new MemoryStore());

    expect(existsSync(marker)).toBe(false);
  });

  it('is invisible to a plain clone', async () => {
    const repository = await checkout();
    await syncRepository(new GitRepository(repository), new MemoryStore());

    const clone = join(root, 'plain-clone');
    git(root, 'clone', '-q', repository, clone);

    expect(git(clone, 'for-each-ref', 'refs/vantik')).toBe('');
    expect(git(clone, 'branch', '-a')).not.toContain('vantik');
  });

  it('leaves the ref alone when somebody moves it during the pass', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await syncRepository(new GitRepository(repository), store);

    const elsewhere = git(repository, 'rev-parse', 'HEAD');
    store.issues[0].title = 'Renamed in Vantik';
    const load = store.load.bind(store);
    store.load = async () => {
      git(repository, 'update-ref', SNAPSHOT_REF, elsewhere);
      return await load();
    };

    const result = await syncRepository(new GitRepository(repository), store);

    expect(result.wrote).toBe(false);
    expect(git(repository, 'rev-parse', SNAPSHOT_REF)).toBe(elsewhere);
  });

  it('keeps an inbox the store failed on, and still applies the others', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await syncRepository(new GitRepository(repository), store);

    const edit = (from: string, to: string) => async (worktree: string) => {
      const file = join(worktree, 'issues/ENG-1/issue.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
    };

    await handOff(repository, 'fails', edit('priority: high', 'priority: low'));
    await handOff(
      repository,
      'works',
      edit('state: "Backlog"', 'state: "In Progress"'),
    );

    const apply = store.apply.bind(store);
    store.apply = async (reading, source) => {
      if (source.name === 'fails') {
        throw new Error('database unavailable');
      }
      return await apply(reading);
    };

    const failed: string[] = [];
    const result = await syncRepository(new GitRepository(repository), store, {
      onInboxError: (name) => failed.push(name),
    });

    expect(failed).toEqual(['fails']);
    expect(result.handOffs.map((handOff) => handOff.name)).toEqual(['works']);
    expect(
      git(repository, 'for-each-ref', '--format=%(refname)', INBOX_PREFIX),
    ).toBe(`${INBOX_PREFIX}fails`);
    expect(store.issues[0].state).toBe('In Progress');
  });
});
