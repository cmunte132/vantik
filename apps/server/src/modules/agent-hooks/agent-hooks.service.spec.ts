import { PrismaService } from 'nestjs-prisma';

import { CacheService } from 'modules/cache/cache.service';

import { HookInput } from './agent-hooks.harness';
import {
  AgentHooksService,
  HookActor,
  IDLE_MS,
  QUIET_MS,
} from './agent-hooks.service';

const ME = 'agent-1';
const SOMEONE_ELSE = 'person-1';
const actor: HookActor = { userId: ME, workspaceId: 'ws-1' };
const MINUTE = 60_000;
const T0 = new Date('2026-09-26T09:00:00Z').getTime();

interface Write {
  issueId: string;
  userId: string;
  at: number;
}

/**
 * The tracker as the rules read it. Only the queries the service makes are
 * modelled, and each honours the filters that decide the answer — whose write
 * it was above all, since someone else's note must not count as the agent's.
 */
function fakeTracker() {
  const issues = [
    {
      id: 'issue-42',
      number: 42,
      title: 'Rate-limit the webhook',
      assigneeId: ME,
      updatedAt: new Date(T0 - 3 * 60 * MINUTE),
      updatedById: SOMEONE_ELSE,
      team: { identifier: 'ENG' },
    },
  ];
  const criteria = [
    { issueId: 'issue-42', completed: true },
    { issueId: 'issue-42', completed: false },
    { issueId: 'issue-42', completed: false },
  ];
  const notes: Write[] = [];
  const history: Write[] = [];
  const ticks: Write[] = [];
  const calls = { issueFindMany: 0 };
  let failing = false;

  const latest = (rows: Write[], ids: string[], userId: string) =>
    ids
      .map((issueId) => {
        const mine = rows.filter(
          (row) => row.issueId === issueId && row.userId === userId,
        );
        return mine.length === 0
          ? null
          : {
              issueId,
              at: new Date(Math.max(...mine.map((row) => row.at))),
            };
      })
      .filter((row): row is { issueId: string; at: Date } => row !== null);

  const prisma = {
    workflow: {
      findMany: async () => {
        if (failing) {
          throw new Error('database unavailable');
        }
        return [{ id: 'state-started' }];
      },
    },
    issue: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        calls.issueFindMany += 1;
        return issues.filter((issue) => issue.assigneeId === where.assigneeId);
      },
    },
    checklistItem: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      groupBy: async ({ by, where }: any) => {
        const ids: string[] = where.issueId.in;

        if (by.length === 2) {
          const counts = new Map<string, number>();
          for (const row of criteria.filter((c) => ids.includes(c.issueId))) {
            const key = `${row.issueId}|${row.completed}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          return [...counts].map(([key, count]) => {
            const [issueId, completed] = key.split('|');
            return {
              issueId,
              completed: completed === 'true',
              _count: { _all: count },
            };
          });
        }

        const userId = where.OR[0].updatedById;
        return latest(ticks, ids, userId).map(({ issueId, at }) => ({
          issueId,
          _max: { updatedAt: at },
        }));
      },
    },
    issueComment: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      groupBy: async ({ where }: any) =>
        latest(notes, where.issueId.in, where.userId).map(
          ({ issueId, at }) => ({ issueId, _max: { createdAt: at } }),
        ),
    },
    issueHistory: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      groupBy: async ({ where }: any) =>
        latest(history, where.issueId.in, where.userId).map(
          ({ issueId, at }) => ({ issueId, _max: { createdAt: at } }),
        ),
    },
  };

  return {
    prisma: prisma as unknown as PrismaService,
    issues,
    notes,
    history,
    ticks,
    calls,
    fail: () => {
      failing = true;
    },
  };
}

/** Redis as the service uses it, with a switch to take it away. */
function fakeCache() {
  const store = new Map<string, string>();
  let down = false;
  let readOnly = false;

  const cache = {
    get: async (key: string) => (down ? null : (store.get(key) ?? null)),
    set: async (key: string, value: string) => {
      if (down || readOnly) {
        throw new Error('connection refused');
      }
      store.set(key, value);
      return 'OK' as const;
    },
  };

  return {
    cache: cache as unknown as CacheService,
    goDown: () => {
      down = true;
    },
    /** Reads still answer; writes fail — a full disk, a replica. */
    stopWrites: () => {
      readOnly = true;
    },
  };
}

function setup() {
  const tracker = fakeTracker();
  const store = fakeCache();
  const service = new AgentHooksService(tracker.prisma, store.cache);

  const hook = (
    event: 'session-start' | 'prompt' | 'stop',
    input: Partial<HookInput> = {},
  ) =>
    service.run(event, actor, {
      sessionId: 'session-a',
      source: null,
      continued: false,
      ...input,
    });

  return { ...tracker, ...store, service, hook };
}

function at(minutes: number) {
  jest.setSystemTime(T0 + minutes * MINUTE);
}

beforeEach(() => {
  jest.useFakeTimers();
  at(0);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the session brief', () => {
  it('names what the agent has in progress on the first prompt', async () => {
    const { hook } = setup();

    const brief = await hook('prompt');

    expect(brief).toContain('you have 1 issue in progress');
    expect(brief).toContain(
      'ENG-42 Rate-limit the webhook: 1 of 3 criteria met; you have not updated it.',
    );
    expect(brief).toContain('load_context');
  });

  it('says nothing on the prompts after that', async () => {
    const { hook } = setup();

    await hook('prompt');
    at(10);

    expect(await hook('prompt')).toBeNull();
  });

  it('briefs again when a session comes back from being idle', async () => {
    // Resumed the next morning, the session is starting over, and yesterday's
    // brief is long out of its context.
    const { hook } = setup();

    await hook('prompt');
    at(IDLE_MS / MINUTE + 1);

    expect(await hook('prompt')).toContain('ENG-42');
  });

  it('points at the work loop when nothing is in progress', async () => {
    const { hook, issues } = setup();
    issues.length = 0;

    const brief = await hook('prompt');

    expect(brief).toContain('nothing is in progress under your name');
    expect(brief).toContain('pick_up_task');
  });

  it('reports when the agent last recorded anything on the issue', async () => {
    const { hook, notes } = setup();
    notes.push({ issueId: 'issue-42', userId: ME, at: T0 - 3 * 60 * MINUTE });

    expect(await hook('prompt')).toContain('your last update was 3 hours ago');
  });
});

describe('the stop check', () => {
  it('lets a session shorter than the quiet threshold stop', async () => {
    // However stale the issue, a session this short has not had time to
    // leave anything out of date.
    const { hook } = setup();

    await hook('prompt');
    at(QUIET_MS / MINUTE - 1);

    expect(await hook('stop')).toBeNull();
  });

  it('holds up a stop once the issue has gone quiet for the whole threshold', async () => {
    const { hook } = setup();

    await hook('prompt');
    at(25);
    const reason = await hook('stop');

    expect(reason).toContain(
      'ENG-42 Rate-limit the webhook: 1 of 3 criteria met; nothing recorded on it for 25 minutes.',
    );
    expect(reason).toContain('update_criteria');
    // The way out, for a session that never touched the issue.
    expect(reason).toContain('say so in one line and stop');
  });

  it('asks only once for each quiet stretch', async () => {
    const { hook } = setup();

    await hook('prompt');
    at(25);
    await hook('stop');
    at(26);

    expect(await hook('stop')).toBeNull();
    at(90);
    expect(await hook('stop')).toBeNull();
  });

  it('asks again only after a new word on the issue goes quiet in turn', async () => {
    const { hook, notes } = setup();

    await hook('prompt');
    at(25);
    await hook('stop');

    notes.push({ issueId: 'issue-42', userId: ME, at: T0 + 30 * MINUTE });
    at(45);
    expect(await hook('stop')).toBeNull();

    at(51);
    expect(await hook('stop')).toContain(
      'nothing recorded on it for 21 minutes',
    );
  });

  it('counts a ticked criterion as a word on the issue', async () => {
    const { hook, ticks } = setup();

    await hook('prompt');
    ticks.push({ issueId: 'issue-42', userId: ME, at: T0 + 10 * MINUTE });
    at(25);

    expect(await hook('stop')).toBeNull();
  });

  it('counts a state change as a word on the issue', async () => {
    const { hook, history } = setup();

    await hook('prompt');
    history.push({ issueId: 'issue-42', userId: ME, at: T0 + 10 * MINUTE });
    at(25);

    expect(await hook('stop')).toBeNull();
  });

  it('does not count someone else writing on the issue', async () => {
    const { hook, notes } = setup();

    await hook('prompt');
    notes.push({
      issueId: 'issue-42',
      userId: SOMEONE_ELSE,
      at: T0 + 20 * MINUTE,
    });
    at(25);

    expect(await hook('stop')).toContain('ENG-42');
  });

  it('lets the agent stop when it never saw the session begin', async () => {
    const { hook } = setup();
    at(90);

    expect(await hook('stop')).toBeNull();
  });

  it('lets the agent stop when the harness is already continuing for a hook', async () => {
    const { hook } = setup();

    await hook('prompt');
    at(25);

    expect(await hook('stop', { continued: true })).toBeNull();
  });

  it('never holds up a stop it cannot record', async () => {
    // Unrecorded, the same silence would hold the agent up on every turn.
    const { hook, stopWrites } = setup();

    await hook('prompt');
    at(25);
    stopWrites();

    expect(await hook('stop')).toBeNull();
  });

  it('lets the agent stop when the store is unreachable', async () => {
    const { hook, goDown } = setup();

    await hook('prompt');
    at(25);
    goDown();

    expect(await hook('stop')).toBeNull();
  });

  it('carries on quietly when the tracker cannot be read', async () => {
    const { hook, fail } = setup();

    await hook('prompt');
    at(25);
    fail();

    await expect(hook('stop')).resolves.toBeNull();
  });

  it('keeps the session clock running through a compaction', async () => {
    const { hook } = setup();

    await hook('session-start', { source: 'startup' });
    at(15);
    await hook('session-start', { source: 'compact' });
    at(21);

    expect(await hook('stop')).toContain('ENG-42');
  });

  it('starts the clock again for a new session', async () => {
    const { hook } = setup();

    await hook('session-start', { source: 'startup' });
    at(15);
    await hook('session-start', { source: 'clear' });
    at(21);

    expect(await hook('stop')).toBeNull();
  });

  it('does not look at the tracker for a hook with no session id', async () => {
    const { service, calls } = setup();

    expect(
      await service.run('stop', actor, {
        sessionId: null,
        source: null,
        continued: false,
      }),
    ).toBeNull();
    expect(calls.issueFindMany).toBe(0);
  });
});
