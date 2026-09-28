import { PrismaService } from 'nestjs-prisma';

import { CacheService } from 'modules/cache/cache.service';
import { KnowledgeSearchHit } from 'modules/vector/vector.interface';
import { VectorService } from 'modules/vector/vector.service';

import { HookEvent, HookInput } from './agent-hooks.harness';
import {
  AgentHooksService,
  EDITS_WORTH_AN_ISSUE,
  HookActor,
  IDLE_MS,
  POINTER_DISTANCE,
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
    entries: store,
    goDown: () => {
      down = true;
    },
    /** Reads still answer; writes fail — a full disk, a replica. */
    stopWrites: () => {
      readOnly = true;
    },
  };
}

/**
 * The knowledge index as the hook reads it: every search answers with the
 * same hits, and each search is recorded so a test can see what was asked.
 */
function fakeIndex() {
  const hits: KnowledgeSearchHit[] = [];
  const searches: Array<{ query: string; options: unknown }> = [];
  let failing = false;

  const vector = {
    searchKnowledge: async (
      _workspaceId: string,
      query: string,
      options: unknown,
    ) => {
      searches.push({ query, options });
      if (failing) {
        throw new Error('typesense unavailable');
      }
      return { hits, facets: {}, found: hits.length };
    },
  };

  return {
    vector: vector as unknown as VectorService,
    hits,
    searches,
    failSearch: () => {
      failing = true;
    },
  };
}

function hit(
  pageId: string,
  pageTitle: string,
  distance: number | undefined,
  scope: string | null = null,
): KnowledgeSearchHit {
  return {
    id: `entry:${pageId}:${distance}`,
    kind: 'entry',
    pageId,
    pageTitle,
    entryId: `${pageId}-entry`,
    title: pageTitle,
    content: 'A claim.',
    scope,
    status: 'STANDING',
    sourceUserId: null,
    verified: false,
    retrievalCount: 0,
    trust: null,
    citations: [],
    lastCheckedAt: null,
    lastCheckedSha: null,
    distance,
  } as KnowledgeSearchHit;
}

const A_PROMPT = 'Why does the sync engine drop updates after a reconnect?';

function setup() {
  const tracker = fakeTracker();
  const store = fakeCache();
  const index = fakeIndex();
  const service = new AgentHooksService(
    tracker.prisma,
    store.cache,
    index.vector,
  );

  const hook = (
    event: HookEvent,
    input: Partial<HookInput> = {},
    options?: { canSay?: boolean },
  ) =>
    service.run(
      event,
      actor,
      {
        sessionId: 'session-a',
        source: null,
        prompt: null,
        toolName: null,
        continued: false,
        ...input,
      },
      options,
    );

  const edits = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      await hook('tool-use', { toolName: 'Edit' }, { canSay: false });
    }
  };

  /** The hooks as Cursor sends them: it cannot add context on these two. */
  const cursor = {
    prompt: (prompt: string) => hook('prompt', { prompt }, { canSay: false }),
    compact: () => hook('compact', {}, { canSay: false }),
    tool: (toolName: string) => hook('tool-use', { toolName }),
  };

  return { ...tracker, ...store, ...index, service, hook, edits, cursor };
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
        prompt: null,
        toolName: null,
        continued: false,
      }),
    ).toBeNull();
    expect(calls.issueFindMany).toBe(0);
  });
});

describe('work with no issue', () => {
  it('holds up a stop when the session changed files and nothing is in progress', async () => {
    const { hook, issues, edits } = setup();
    issues.length = 0;

    await hook('prompt');
    await edits(EDITS_WORTH_AN_ISSUE);
    const reason = await hook('stop');

    expect(reason).toContain(
      `this session changed files ${EDITS_WORTH_AN_ISSUE} times, and nothing is in progress under your name`,
    );
    expect(reason).toContain('create_task');
    expect(reason).toContain('pick_up_task');
    // The way out, for a small fix or a repository that is not on Vantik.
    expect(reason).toContain('say so in one line and stop');
  });

  it('lets a session with only a few edits stop', async () => {
    const { hook, issues, edits } = setup();
    issues.length = 0;

    await hook('prompt');
    await edits(EDITS_WORTH_AN_ISSUE - 1);

    expect(await hook('stop')).toBeNull();
  });

  it('asks only once in a stretch, whatever the agent answered', async () => {
    const { hook, issues, edits } = setup();
    issues.length = 0;

    await hook('prompt');
    await edits(EDITS_WORTH_AN_ISSUE);
    await hook('stop');
    await edits(EDITS_WORTH_AN_ISSUE * 3);

    expect(await hook('stop')).toBeNull();
  });

  it('asks again in a new stretch that does its own work', async () => {
    const { hook, issues, edits } = setup();
    issues.length = 0;

    await hook('prompt');
    await edits(EDITS_WORTH_AN_ISSUE);
    await hook('stop');

    at(IDLE_MS / MINUTE + 5);
    await hook('prompt');
    expect(await hook('stop')).toBeNull();

    await edits(EDITS_WORTH_AN_ISSUE);
    expect(await hook('stop')).toContain('nothing is in progress');
  });

  it('leaves work on an issue in progress to the quiet check', async () => {
    const { hook, edits } = setup();

    await hook('prompt');
    await edits(EDITS_WORTH_AN_ISSUE);

    expect(await hook('stop')).toBeNull();
  });

  it('counts nothing for a session it never saw begin', async () => {
    const { hook, issues, edits } = setup();
    issues.length = 0;

    await edits(EDITS_WORTH_AN_ISSUE);

    expect(await hook('stop')).toBeNull();
  });

  it('says nothing back to an edit', async () => {
    const { hook } = setup();

    await hook('prompt');

    expect(
      await hook('tool-use', { toolName: 'Edit' }, { canSay: false }),
    ).toBeNull();
  });

  it('reads a session recorded before edits were counted', async () => {
    // A record written by the previous release has no edit count; it must
    // read as none, not as NaN that never reaches the threshold or throws.
    const { hook, issues, edits, entries } = setup();
    issues.length = 0;
    await hook('prompt');
    const [key] = [...entries.keys()];
    entries.set(key, JSON.stringify({ startedAt: T0, seenAt: T0, nudged: {} }));

    await edits(EDITS_WORTH_AN_ISSUE);

    expect(await hook('stop')).toContain('nothing is in progress');
  });
});

describe('pointers to the knowledge bank', () => {
  it('names the pages that match the prompt, with no content', async () => {
    const { hook, hits } = setup();
    hits.push(
      hit('page-sync', 'Sync engine', 0.3, 'apps/server/src/modules/sync'),
      hit('page-sync', 'Sync engine', 0.4),
      hit('page-auth', 'Auth', 0.5),
    );

    const said = await hook('prompt', { prompt: A_PROMPT });

    expect(said).toContain('ENG-42');
    expect(said).toContain(
      '- "Sync engine" (2 matches, scope apps/server/src/modules/sync)',
    );
    expect(said).toContain('- "Auth" (1 match)');
    expect(said).toContain('load_context');
    expect(said).not.toContain('A claim.');
  });

  it('points on later prompts too, without the brief', async () => {
    const { hook, hits } = setup();

    await hook('prompt', { prompt: A_PROMPT });
    hits.push(hit('page-sync', 'Sync engine', 0.3));
    at(5);
    const said = await hook('prompt', { prompt: A_PROMPT });

    expect(said).toContain('"Sync engine"');
    expect(said).not.toContain('ENG-42');
  });

  it('names a page only once in a session', async () => {
    const { hook, hits } = setup();
    hits.push(hit('page-sync', 'Sync engine', 0.3));

    await hook('prompt', { prompt: A_PROMPT });
    at(5);

    expect(await hook('prompt', { prompt: A_PROMPT })).toBeNull();
  });

  it('names the pages again after a compaction', async () => {
    // The summary may not have kept them.
    const { hook, hits } = setup();
    hits.push(hit('page-sync', 'Sync engine', 0.3));

    await hook('prompt', { prompt: A_PROMPT });
    at(5);
    await hook('session-start', { source: 'compact' });
    at(6);

    expect(await hook('prompt', { prompt: A_PROMPT })).toContain(
      '"Sync engine"',
    );
  });

  it('ignores a weak match, and one found by its words alone', async () => {
    const { hook, hits } = setup();
    hits.push(
      hit('page-far', 'Far', POINTER_DISTANCE + 0.05),
      hit('page-words', 'Words', undefined),
    );
    at(0);

    const said = await hook('prompt', { prompt: A_PROMPT });

    expect(said).not.toContain('Far');
    expect(said).not.toContain('Words');
  });

  it('names at most three pages', async () => {
    const { hook, hits } = setup();
    hits.push(
      hit('p1', 'One', 0.1),
      hit('p2', 'Two', 0.2),
      hit('p3', 'Three', 0.3),
      hit('p4', 'Four', 0.4),
    );

    const said = await hook('prompt', { prompt: A_PROMPT });

    expect(said).toContain('"Three"');
    expect(said).not.toContain('"Four"');
  });

  it('does not search for a short prompt', async () => {
    const { hook, searches } = setup();

    await hook('prompt', { prompt: 'yes, go on' });

    expect(searches).toEqual([]);
  });

  it('searches the index with the tight distance, never through demand', async () => {
    // KnowledgeService would count the hits as demand and a miss as a gap;
    // the hook goes to the index so neither is recorded.
    const { hook, searches } = setup();

    await hook('prompt', { prompt: A_PROMPT });

    expect(searches).toEqual([
      {
        query: A_PROMPT,
        options: { limit: 10, vectorDistance: POINTER_DISTANCE },
      },
    ]);
  });

  it('still briefs when the search fails', async () => {
    const { hook, failSearch } = setup();
    failSearch();

    expect(await hook('prompt', { prompt: A_PROMPT })).toContain('ENG-42');
  });
});

describe('a harness that cannot add context on every event', () => {
  it('keeps the pointers from a Cursor prompt for the next tool', async () => {
    const { hook, hits, cursor } = setup();
    hits.push(hit('page-sync', 'Sync engine', 0.3));

    await hook('session-start', { source: 'startup' });
    expect(await cursor.prompt(A_PROMPT)).toBeNull();

    expect(await cursor.tool('Read')).toContain('"Sync engine"');
  });

  it('gives what it kept only once', async () => {
    const { hook, hits, cursor } = setup();
    hits.push(hit('page-sync', 'Sync engine', 0.3));

    await hook('session-start', { source: 'startup' });
    await cursor.prompt(A_PROMPT);
    await cursor.tool('Read');

    expect(await cursor.tool('Read')).toBeNull();
  });

  it('keeps the brief from a Cursor compaction for the next tool', async () => {
    const { hook, cursor } = setup();

    await hook('session-start', { source: 'startup' });
    at(5);
    expect(await cursor.compact()).toBeNull();

    expect(await cursor.tool('Grep')).toContain('ENG-42');
  });

  it('keeps the clock and the edits through a Cursor compaction', async () => {
    const { hook, issues, cursor } = setup();
    issues.length = 0;

    await hook('session-start', { source: 'startup' });
    for (let i = 0; i < EDITS_WORTH_AN_ISSUE; i += 1) {
      await cursor.tool('Write');
    }
    await cursor.compact();

    expect(await hook('stop')).toContain('nothing is in progress');
  });

  it('counts only the Cursor tools that change a file', async () => {
    const { hook, issues, cursor } = setup();
    issues.length = 0;

    await hook('session-start', { source: 'startup' });
    for (let i = 0; i < EDITS_WORTH_AN_ISSUE; i += 1) {
      await cursor.tool('Read');
      await cursor.tool('Shell');
    }
    expect(await hook('stop')).toBeNull();

    for (let i = 0; i < EDITS_WORTH_AN_ISSUE; i += 1) {
      await cursor.tool(i % 2 ? 'Write' : 'Delete');
    }
    expect(await hook('stop')).toContain('nothing is in progress');
  });

  it('never gives Claude Code a kept message on its edit hook', async () => {
    // Claude Code takes the pointers on the prompt itself, so it keeps none,
    // and its edit hook says nothing.
    const { hook, hits } = setup();
    hits.push(hit('page-sync', 'Sync engine', 0.3));

    expect(await hook('prompt', { prompt: A_PROMPT })).toContain('Sync');
    expect(
      await hook('tool-use', { toolName: 'Edit' }, { canSay: false }),
    ).toBeNull();
  });
});
