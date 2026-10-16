import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { anonymousRemote } from 'modules/git/git-command';

import { type Lookups, type Outcome, planCreate, planUpdate } from './apply';
import { GitRepository } from './git';
import { type InboxReading, OUTBOX_LINES_READ } from './inbox';
import { gitIssueRemote, HostRefusedPushError } from './issue-remote';
import { type Snapshot, type SnapshotIssue } from './snapshot';
import {
  type HandOffSource,
  INBOX_PREFIX,
  MAX_FILE_BYTES,
  MAX_INBOXES_PER_PASS,
  snapshotMessage,
  type MirrorStore,
  SNAPSHOT_REF,
  syncRepository,
} from './sync';

/**
 * The mirror against real repositories, because what is being tested is what
 * git does: which refs move, what a plain clone sees, whether a checkout is
 * disturbed, whether a hook runs. The source is a checkout in a temporary
 * directory. The pass works in a bare mirror of it, as the server does. The
 * store is an in-memory stand-in for the database that applies proposals with
 * the same planning rules the service uses.
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

  /** The text of each outbox that a hand-off added lines to. */
  outboxes: string[] = [];

  /** The source of each hand-off that had proposals to apply. */
  sources: HandOffSource[] = [];

  async apply(
    reading: InboxReading,
    source?: HandOffSource,
  ): Promise<Outcome[]> {
    if (source && reading.proposals.length > 0) {
      this.sources.push(source);
    }

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

      if (proposal.kind === 'outbox') {
        this.outboxes.push(proposal.text);
        return { path: proposal.path, applied: ['outbox read'], refused: [] };
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

// A pass starts many git processes, and a test makes several passes.
jest.setTimeout(60_000);

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

const mirrors = new Map<string, string>();
let refuseDeletes = false;

/** One pass over `repository`, in a bare mirror that it keeps between passes. */
async function pass(
  repository: string,
  store: MirrorStore,
  options: Parameters<typeof syncRepository>[3] = {},
) {
  let path = mirrors.get(repository);

  if (!path) {
    path = await mkdtemp(join(root, 'mirror-'));
    git(path, 'init', '-q', '--bare');
    mirrors.set(repository, path);
  }

  const remote = anonymousRemote(repository);

  const real = gitIssueRemote(path, { fetch: remote, push: remote }, (work) =>
    work(),
  );

  // Git enforces `receive.denyDeletes` only for branches, so a host that
  // refuses to delete refs/vantik/* is played here: the push is refused
  // before it reaches the source, as a protected-ref rule does.
  const refuse = () => {
    throw new HostRefusedPushError(
      `${INBOX_PREFIX}*`,
      '! [remote rejected] (deletion prohibited)',
    );
  };

  return await syncRepository(
    new GitRepository(path),
    {
      ...real,
      deleteInbox: async (ref, sha) =>
        refuseDeletes ? refuse() : real.deleteInbox(ref, sha),
      deleteInboxes: async (entries) =>
        refuseDeletes ? refuse() : real.deleteInboxes(entries),
    },
    store,
    options,
  );
}

/** What an agent does, with plain git and nothing else. */
async function handOff(
  repository: string,
  name: string,
  edit: (worktree: string) => Promise<void>,
  message = `proposal ${name}`,
) {
  const worktree = join(root, `worktree-${name}`);

  git(repository, 'worktree', 'add', '-q', '--detach', worktree, SNAPSHOT_REF);
  await edit(worktree);
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', message);
  git(worktree, 'update-ref', `${INBOX_PREFIX}${name}`, 'HEAD');
  git(repository, 'worktree', 'remove', '--force', worktree);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vantik-git-issues-'));
});

afterEach(() => {
  refuseDeletes = false;
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

    const result = await pass(repository, new MemoryStore());

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
    const first = await pass(repository, store);
    const second = await pass(repository, store);

    expect(second.wrote).toBe(false);
    expect(second.tip).toBe(first.tip);
  });

  it('applies an inbox, deletes it, and answers in the next snapshot', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

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

    const result = await pass(repository, store);

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
    await pass(repository, store);

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

    await pass(repository, store);

    expect(store.issues[0]).toMatchObject({
      state: 'In Progress',
      priority: 1,
    });
  });

  it('refuses an inbox that is not built on the snapshot', async () => {
    const repository = await checkout();
    await pass(repository, new MemoryStore());
    git(repository, 'update-ref', `${INBOX_PREFIX}stray`, 'HEAD');

    const result = await pass(repository, new MemoryStore());

    expect(result.handOffs[0].outcomes[0].refused[0]).toMatch(
      /not built on refs\/vantik\/issues/,
    );
    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toBe('');
  });

  it('files a new issue from new/', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    await handOff(repository, 'filing', async (worktree) => {
      await mkdir(join(worktree, 'new'));
      await writeFile(
        join(worktree, 'new/dark-mode.md'),
        '---\ntitle: Dark mode resets on reload\n---\n\nToggle, reload.\n',
      );
    });

    await pass(repository, store);

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
    await pass(repository, store);

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

    const result = await pass(repository, store);

    expect(result.handOffs.map((handOff) => handOff.name)).toEqual(['direct']);
    expect(store.issues[0].priority).toBe(4);
    expect(git(repository, 'rev-parse', `${SNAPSHOT_REF}^`)).toBe(direct);
  });

  it('never runs a hook of the checkout, on either side of a push', async () => {
    const repository = await checkout();
    const marker = join(root, 'hook-ran');
    const store = new MemoryStore();

    // Every hook that a fetch, a push or a ref change in the checkout can run.
    for (const name of [
      'reference-transaction',
      'pre-receive',
      'update',
      'post-receive',
      'post-update',
      'push-to-checkout',
      'pre-push',
    ]) {
      await writeFile(
        join(repository, '.git/hooks', name),
        `#!/bin/sh\necho ${name} >> ${marker}\n`,
        { mode: 0o755 },
      );
    }

    // The first pass pushes the snapshot. The second reads an inbox and then
    // deletes its ref at the source, which is a second kind of push.
    const first = await pass(repository, store);
    expect(first.wrote).toBe(true);

    await handOff(repository, 'hooked', async (worktree) => {
      const file = join(worktree, 'issues/ENG-1/issue.md');
      await writeFile(
        file,
        (await readFile(file, 'utf8')).replace(
          'priority: high',
          'priority: low',
        ),
      );
    });
    // The hand-off made its commit and its ref through hooks of its own, which
    // is not under test. Start from a clean marker.
    await rm(marker, { force: true });

    const second = await pass(repository, store);

    expect(second.wrote).toBe(true);
    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it('never runs a hook of the mirror', async () => {
    const repository = await checkout();
    const marker = join(root, 'mirror-hook-ran');

    await pass(repository, new MemoryStore());

    const mirror = mirrors.get(repository)!;
    await writeFile(
      join(mirror, 'hooks/reference-transaction'),
      `#!/bin/sh\necho x >> ${marker}\n`,
      { mode: 0o755 },
    );
    const store = new MemoryStore();
    store.issues[0].title = 'Renamed';
    await pass(repository, store);

    expect(existsSync(marker)).toBe(false);
  });

  it('is invisible to a plain clone', async () => {
    const repository = await checkout();
    await pass(repository, new MemoryStore());

    const clone = join(root, 'plain-clone');
    git(root, 'clone', '-q', repository, clone);

    expect(git(clone, 'for-each-ref', 'refs/vantik')).toBe('');
    expect(git(clone, 'branch', '-a')).not.toContain('vantik');
  });

  it('leaves the ref alone when somebody moves it during the pass', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    const elsewhere = git(repository, 'rev-parse', 'HEAD');
    const tip = git(repository, 'rev-parse', SNAPSHOT_REF);
    store.issues[0].title = 'Renamed in Vantik';
    const load = store.load.bind(store);
    store.load = async () => {
      git(repository, 'update-ref', SNAPSHOT_REF, elsewhere);
      return await load();
    };

    const result = await pass(repository, store);

    expect(result.wrote).toBe(false);
    // The lease held the source back, and the mirror went back to the tip
    // that the pass started from.
    expect(git(repository, 'rev-parse', SNAPSHOT_REF)).toBe(elsewhere);
    expect(git(mirrors.get(repository)!, 'rev-parse', SNAPSHOT_REF)).toBe(tip);
  });

  it('keeps the inbox ref until the snapshot is pushed, then deletes it', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    await handOff(repository, 'late', async (worktree) => {
      const file = join(worktree, 'issues/ENG-1/issue.md');
      await writeFile(
        file,
        (await readFile(file, 'utf8')).replace(
          'state: "Backlog"',
          'state: "In Progress"',
        ),
      );
    });

    // A lock file makes git refuse any update of the ref at the source.
    const lock = join(repository, '.git/refs/vantik/issues.lock');
    const load = store.load.bind(store);
    store.load = async () => {
      await writeFile(lock, '');
      return await load();
    };

    const failed = await pass(repository, store);

    expect(failed.wrote).toBe(false);
    expect(
      git(repository, 'for-each-ref', '--format=%(refname)', INBOX_PREFIX),
    ).toBe(`${INBOX_PREFIX}late`);

    await rm(lock);
    store.load = load;
    const retried = await pass(repository, store);

    expect(retried.wrote).toBe(true);
    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toBe('');
    expect(git(repository, 'log', '-1', '--format=%B', SNAPSHOT_REF)).toContain(
      'Vantik-Inbox: late',
    );
    expect(store.issues[0].state).toBe('In Progress');
  });

  it('does not apply a follow-up hand-off on top of an earlier one twice', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    const worktree = join(root, 'worktree-follow-up');
    git(
      repository,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      SNAPSHOT_REF,
    );

    // The first hand-off: a comment, a new issue and a new priority.
    await mkdir(join(worktree, 'issues/ENG-1/comments'), { recursive: true });
    await writeFile(
      join(worktree, 'issues/ENG-1/comments/note.md'),
      'The submit handler never fires.\n',
    );
    await mkdir(join(worktree, 'new'));
    await writeFile(
      join(worktree, 'new/dark-mode.md'),
      '---\ntitle: Dark mode resets on reload\n---\n\nToggle, reload.\n',
    );
    const issueFile = join(worktree, 'issues/ENG-1/issue.md');
    await writeFile(
      issueFile,
      (await readFile(issueFile, 'utf8')).replace(
        'priority: high',
        'priority: low',
      ),
    );
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'first');
    git(worktree, 'update-ref', `${INBOX_PREFIX}one`, 'HEAD');

    await pass(repository, store);

    expect(store.issues).toHaveLength(2);
    expect(store.issues[0].comments).toHaveLength(1);

    // The second hand-off is built on the first, not on the new snapshot. The
    // agent never fetched the snapshot that answered the first.
    await writeFile(
      issueFile,
      (await readFile(issueFile, 'utf8')).replace(
        'state: "Backlog"',
        'state: "In Progress"',
      ),
    );
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'second');
    git(worktree, 'update-ref', `${INBOX_PREFIX}two`, 'HEAD');

    const result = await pass(repository, store);

    expect(store.issues).toHaveLength(2);
    expect(store.issues[0].comments).toHaveLength(1);
    expect(store.issues[0].state).toBe('In Progress');
    expect(result.handOffs.flatMap((handOff) => handOff.outcomes)).toEqual([
      expect.objectContaining({
        refused: [],
        applied: ['ENG-1 state: Backlog → In Progress'],
      }),
    ]);
    // The first hand-off is a parent of the snapshot that answered it.
    const parents = git(
      repository,
      'rev-list',
      '--parents',
      '-n1',
      `${SNAPSHOT_REF}~1`,
    )
      .split(' ')
      .slice(1);
    expect(parents).toHaveLength(2);
  });

  it('refuses an inbox ref that points at a blob or a tree, and deletes it', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    git(
      repository,
      'update-ref',
      `${INBOX_PREFIX}blob`,
      git(repository, 'rev-parse', 'HEAD:app.js'),
    );
    git(
      repository,
      'update-ref',
      `${INBOX_PREFIX}tree`,
      git(repository, 'rev-parse', 'HEAD^{tree}'),
    );
    await handOff(repository, 'fine', async (worktree) => {
      const file = join(worktree, 'issues/ENG-1/issue.md');
      await writeFile(
        file,
        (await readFile(file, 'utf8')).replace(
          'priority: high',
          'priority: low',
        ),
      );
    });

    const result = await pass(repository, store);

    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toBe('');
    const byName = Object.fromEntries(
      result.handOffs.map((handOff) => [handOff.name, handOff]),
    );
    expect(byName.blob.outcomes[0].refused[0]).toMatch(/points at a blob/);
    expect(byName.tree.outcomes[0].refused[0]).toMatch(/points at a tree/);
    expect(byName.fine.outcomes[0].applied).toHaveLength(1);
    expect(store.issues[0].priority).toBe(4);
    expect(git(repository, 'log', '-1', '--format=%B', SNAPSHOT_REF)).toContain(
      'Vantik-Inbox: blob',
    );

    // Nothing is left to wedge the next pass.
    const next = await pass(repository, store);
    expect(next.handOffs).toEqual([]);
  });

  it('refuses a file over the size limit, and a hand-off over the total limit', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    await handOff(repository, 'big', async (worktree) => {
      const comments = join(worktree, 'issues/ENG-1/comments');
      await mkdir(comments, { recursive: true });
      await writeFile(
        join(comments, 'huge.md'),
        'x'.repeat(MAX_FILE_BYTES + 1),
      );

      // Each file fits, and together they are over the total limit.
      for (let index = 0; index < 45; index++) {
        await writeFile(
          join(comments, `part-${String(index).padStart(2, '0')}.md`),
          `${index} `.padEnd(200_000, 'y'),
        );
      }
    });

    const result = await pass(repository, store);
    const refused = result.handOffs[0].outcomes.flatMap((outcome) =>
      outcome.refused.map((reason) => `${outcome.path}: ${reason}`),
    );

    expect(refused).toContainEqual(
      'issues/ENG-1/comments/huge.md: larger than 256 KiB',
    );
    expect(
      refused.filter((line) => /MiB of files in total/.test(line)).length,
    ).toBeGreaterThan(0);
    expect(store.issues[0].comments.length).toBeGreaterThan(0);
    expect(store.issues[0].comments.length).toBeLessThan(45);
  });

  it('keeps an inbox the store failed on, and still applies the others', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

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
    const result = await pass(repository, store, {
      onInboxError: (name) => failed.push(name),
    });

    expect(failed).toEqual(['fails']);
    expect(result.handOffs.map((handOff) => handOff.name)).toEqual(['works']);
    expect(
      git(repository, 'for-each-ref', '--format=%(refname)', INBOX_PREFIX),
    ).toBe(`${INBOX_PREFIX}fails`);
    expect(store.issues[0].state).toBe('In Progress');
  });

  describe('the session trailers of a hand-off', () => {
    const comment =
      (text = 'Found it.\n') =>
      async (worktree: string) => {
        await mkdir(join(worktree, 'issues/ENG-1/comments'), {
          recursive: true,
        });
        await writeFile(join(worktree, 'issues/ENG-1/comments/note.md'), text);
      };

    async function sessionOf(message: string) {
      const repository = await checkout();
      const store = new MemoryStore();
      await pass(repository, store);
      await handOff(repository, 'trailers', comment(), message);
      await pass(repository, store);

      return store.sources[0].session;
    }

    it('names the session and the harness from the trailers', async () => {
      expect(
        await sessionOf(
          'Report\n\nVantik-Session: sess-9\nVantik-Harness: pi\nVantik-Origin: laptop',
        ),
      ).toEqual({ id: 'sess-9', harness: 'pi' });
    });

    it('has no session when no commit has the trailer', async () => {
      expect(await sessionOf('Report')).toBeNull();
    });

    it('reads a harness only with a session', async () => {
      expect(await sessionOf('Report\n\nVantik-Harness: pi')).toBeNull();
    });

    it('does not read a line that is not in the trailer block', async () => {
      expect(
        await sessionOf('Report\n\nVantik-Session: sess-mid\n\nMore text.'),
      ).toBeNull();
    });

    it('refuses an id that is too long', async () => {
      expect(
        await sessionOf(`Report\n\nVantik-Session: ${'x'.repeat(201)}`),
      ).toBeNull();
    });

    it('takes the newest commit that has the trailer', async () => {
      const repository = await checkout();
      const store = new MemoryStore();
      await pass(repository, store);

      const worktree = join(root, 'worktree-two-commits');
      git(
        repository,
        'worktree',
        'add',
        '-q',
        '--detach',
        worktree,
        SNAPSHOT_REF,
      );
      await comment('First.\n')(worktree);
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-q', '-m', 'one\n\nVantik-Session: old');
      await writeFile(
        join(worktree, 'issues/ENG-1/comments/two.md'),
        'Second.\n',
      );
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-q', '-m', 'two\n\nVantik-Session: new');
      git(worktree, 'update-ref', `${INBOX_PREFIX}two-commits`, 'HEAD');
      git(repository, 'worktree', 'remove', '--force', worktree);

      await pass(repository, store);

      expect(store.sources[0].session).toEqual({ id: 'new', harness: null });
    });
  });

  it('reads the lines that a follow-up hand-off appended to the outbox, and no others', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    const worktree = join(root, 'worktree-outbox-follow-up');
    git(
      repository,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      SNAPSHOT_REF,
    );

    const outbox = join(worktree, 'issues/ENG-1/outbox.jsonl');
    const first = '{"v":1,"type":"note","body":"first"}\n';
    const second = '{"v":1,"type":"note","body":"second"}\n';

    await writeFile(outbox, first);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'first');
    git(worktree, 'update-ref', `${INBOX_PREFIX}one`, 'HEAD');
    await pass(repository, store);

    // Built on the first hand-off, as an agent does that never fetched the
    // snapshot that answered it.
    await writeFile(outbox, first + second);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'second');
    git(worktree, 'update-ref', `${INBOX_PREFIX}two`, 'HEAD');
    await pass(repository, store);

    expect(store.outboxes).toEqual([first, second]);
  });
  it('writes no commit for an inbox that the snapshot has absorbed and the host will not delete', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);
    refuseDeletes = true;

    await handOff(repository, 'stuck', async (worktree) => {
      await mkdir(join(worktree, 'issues/ENG-1/comments'), { recursive: true });
      await writeFile(
        join(worktree, 'issues/ENG-1/comments/note.md'),
        'Applied once.\n',
      );
    });

    const errors: unknown[] = [];
    const options = {
      onInboxError: (_: string, error: unknown) => errors.push(error),
    };
    const first = await pass(repository, store, options);

    expect(first.wrote).toBe(true);
    expect(errors).toHaveLength(1);
    // The host kept the ref.
    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toContain('stuck');

    const tip = git(repository, 'rev-parse', SNAPSHOT_REF);

    for (let again = 0; again < 3; again += 1) {
      const result = await pass(repository, store, options);

      expect(result.wrote).toBe(false);
      expect(result.handOffs).toEqual([]);
      expect(git(repository, 'rev-parse', SNAPSHOT_REF)).toBe(tip);
    }

    // One report for each pass, not one for each ref and not a loop.
    expect(errors).toHaveLength(4);
    expect(store.issues[0].comments).toHaveLength(1);
    expect(
      git(
        repository,
        'log',
        '-1',
        '--format=%B',
        '--grep=^Vantik-Inbox: stuck$',
        SNAPSHOT_REF,
      ),
    ).toContain('- applied: comment added');
  });

  it('still deletes an absorbed inbox when the pass writes nothing', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    await handOff(repository, 'again', async (worktree) => {
      await mkdir(join(worktree, 'issues/ENG-1/comments'), { recursive: true });
      await writeFile(join(worktree, 'issues/ENG-1/comments/n.md'), 'Once.\n');
    });

    // The host refuses the delete once, then allows it.
    refuseDeletes = true;
    await pass(repository, store, { onInboxError: () => undefined });
    refuseDeletes = false;

    const tip = git(repository, 'rev-parse', SNAPSHOT_REF);
    const result = await pass(repository, store);

    expect(result.wrote).toBe(false);
    expect(git(repository, 'rev-parse', SNAPSHOT_REF)).toBe(tip);
    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toBe('');
  });

  it('reads at most one limit of hand-offs in a pass, and the rest in the next', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    const total = MAX_INBOXES_PER_PASS + 10;
    const worktree = join(root, 'worktree-many');
    git(
      repository,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      SNAPSHOT_REF,
    );

    for (let index = 0; index < total; index += 1) {
      git(worktree, 'checkout', '-q', '--detach', SNAPSHOT_REF);
      await mkdir(join(worktree, 'issues/ENG-1/comments'), { recursive: true });
      await writeFile(
        join(worktree, `issues/ENG-1/comments/c${index}.md`),
        `Comment ${index}.\n`,
      );
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-q', '-m', `c${index}`);
      git(
        worktree,
        'update-ref',
        `${INBOX_PREFIX}n${String(index).padStart(3, '0')}`,
        'HEAD',
      );
    }

    git(repository, 'worktree', 'remove', '--force', worktree);

    const first = await pass(repository, store);

    expect(first.handOffs).toHaveLength(MAX_INBOXES_PER_PASS);
    expect(
      git(repository, 'for-each-ref', INBOX_PREFIX).split('\n').filter(Boolean),
    ).toHaveLength(10);

    const second = await pass(repository, store);

    expect(second.handOffs).toHaveLength(10);
    expect(git(repository, 'for-each-ref', INBOX_PREFIX)).toBe('');
    expect(store.issues[0].comments).toHaveLength(total);
  });

  it('reads 200 lines of an outbox file and says once that the rest was not read', async () => {
    const repository = await checkout();
    const store = new MemoryStore();
    await pass(repository, store);

    await handOff(repository, 'flood', async (worktree) => {
      await mkdir(join(worktree, 'issues/ENG-1'), { recursive: true });
      await writeFile(
        join(worktree, 'issues/ENG-1/outbox.jsonl'),
        '1\n'.repeat(5000),
      );
    });

    await pass(repository, store);

    const reply = git(
      repository,
      'log',
      '-1',
      '--format=%B',
      '--grep=^Vantik-Inbox: flood$',
      SNAPSHOT_REF,
    );

    expect(store.outboxes[0].split('\n').filter(Boolean)).toHaveLength(
      OUTBOX_LINES_READ,
    );
    expect(reply).toContain(
      `4800 lines past the limit of ${OUTBOX_LINES_READ} were not read`,
    );
    expect(reply.length).toBeLessThan(2000);
  });

  it('caps the reply of one hand-off in lines and in bytes', () => {
    const many = Array.from({ length: 1000 }, (_, index) => `reason ${index}`);
    const heavy: string[] = Array.from({ length: 40 }, () => 'x'.repeat(400));
    const message = snapshotMessage(
      [],
      [
        {
          name: 'big',
          commit: null,
          object: 'a'.repeat(40),
          outcomes: [
            { path: 'a', applied: [], refused: many },
            ...heavy.map((line, index) => ({
              path: `f${index}`,
              applied: [] as string[],
              refused: [
                line,
                line,
                line,
                line,
                line,
                line,
                line,
                line,
                line,
                line,
              ],
            })),
          ],
        },
      ],
      false,
    );

    expect(message).toContain('- ... and 950 more');
    expect(message).toContain('more lines');
    expect(Buffer.byteLength(message)).toBeLessThan(17 * 1024);
  });
});
