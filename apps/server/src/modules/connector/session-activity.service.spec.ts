/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaService } from 'nestjs-prisma';

import { SessionActivityService } from './session-activity.service';

const ID = '01a1212b-ef89-7545-abb3-1339176a6b81';
const peer = { workspaceId: 'ws-1', userId: 'user-1' };
const BASE = Date.parse('2026-10-09T10:00:00.000Z');

/** A time, in milliseconds after the base. */
const at = (ms: number) => new Date(BASE + ms).toISOString();

const user = (ms: number, text: string) => ({
  type: 'message',
  id: `u${ms}`,
  timestamp: at(ms),
  message: { role: 'user', content: [{ type: 'text', text }] },
});

/** An assistant message. A null cost leaves the call with no known amount. */
const assistant = (
  ms: number,
  cost: number | null,
  content: unknown[] = [],
) => ({
  type: 'message',
  id: `a${ms}`,
  timestamp: at(ms),
  message: {
    role: 'assistant',
    model: 'm',
    responseId: `r${ms}`,
    usage:
      cost === null
        ? { input: 1 }
        : { input: 1, output: 1, cost: { total: cost } },
    content: content.length > 0 ? content : [{ type: 'text', text: 'ok' }],
  },
});

/** A pickup of a task. It costs nothing, so the totals show only the calls. */
const pickup = (ms: number, task: string) =>
  assistant(ms, 0, [
    {
      type: 'toolCall',
      id: `p${ms}`,
      name: 'mcp__vantik_pick_up_task',
      arguments: { task },
    },
  ]);

type Row = Record<string, any>;

/**
 * A session row, as `linkedRows` projects it: the issue's number and its
 * team's identifier. `key` is the human key that the test names, such as ENG-1.
 */
function row(id: string, key: string, createdMs: number, extra: Row = {}): Row {
  const [identifier, number] = key.split('-');
  return {
    id,
    issueId: `issue-${key}`,
    issue: { number: Number(number), team: { identifier } },
    createdAt: new Date(BASE + createdMs),
    agentRunId: null,
    agentRun: null,
    terminalSeenAt: null,
    terminalCostUsd: 0,
    terminalTurns: 0,
    terminalUnknownCalls: 0,
    lastActiveAt: new Date(BASE),
    ...extra,
  };
}

/** Applies `increment` and plain values, as Prisma does for an update. */
function apply(target: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      target[key] =
        (target[key] ?? 0) + (value as { increment: number }).increment;
    } else {
      target[key] = value;
    }
  }
}

/** Whether a row matches a where clause: equal, `in`, or `lt`. */
function matches(target: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object') {
      if ('in' in condition) {
        return condition.in.includes(target[key]);
      }
      if ('lt' in condition) {
        return target[key] < condition.lt;
      }
    }
    return target[key] === condition;
  });
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * An in-memory stand-in for the Prisma calls the service makes. Each
 * transaction runs after the one before it, as the row lock makes them run.
 */
function fakeDb(seed: { sessions: Row[]; runs?: Row[] }) {
  const sessions = seed.sessions;
  const runs = seed.runs ?? [];
  const transcripts: Row[] = [];
  const calls: Row[] = [];
  const runEvents: Row[] = [];
  const sessionEvents: Row[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  // A unique key of null is not checked, as a NULL in Postgres is not.
  const insert = (
    table: Row[],
    unique: ((item: Row) => string | null) | null,
    data: Row[],
    skipDuplicates: boolean,
  ) => {
    for (const item of data) {
      const key = unique?.(item) ?? null;
      if (
        key !== null &&
        table.some((existing) => unique?.(existing) === key)
      ) {
        if (skipDuplicates) {
          continue;
        }
        throw new Error('unique constraint');
      }
      table.push({ id: `id-${table.length + 1}`, ...clone(item) });
    }
    return { count: data.length };
  };

  const transcriptKey = (item: Row) =>
    [item.workspaceId, item.actorUserId, item.harness, item.externalId].join(
      '|',
    );
  const callKey = (item: Row) => `${item.transcriptId}|${item.callId}`;
  const sessionStepKey = (item: Row) =>
    item.sourceKey ? `${item.sessionId}|${item.sourceKey}` : null;
  const runStepKey = (item: Row) =>
    item.sourceKey ? `${item.runId}|${item.sourceKey}` : null;

  const flat = (where: Row): Row => {
    const compound = where.workspaceId_actorUserId_harness_externalId;
    if (!compound) {
      return where;
    }
    const flatWhere = { ...where, ...compound };
    delete flatWhere.workspaceId_actorUserId_harness_externalId;
    return flatWhere;
  };

  const db: any = {
    agentSession: {
      findMany: jest.fn(async () => clone(sessions)),
      update: jest.fn(async ({ where, data }: any) => {
        const target = sessions.find((item) => item.id === where.id);
        apply(target!, data);
        return clone(target);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        for (const item of sessions.filter((s) => matches(s, where))) {
          apply(item, data);
        }
        return { count: 1 };
      }),
    },
    agentRun: {
      findUnique: jest.fn(async ({ where }: any) =>
        clone(runs.find((item) => item.id === where.id) ?? null),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        apply(
          runs.find((item) => item.id === where.id)!,
          data,
        );
        return {};
      }),
    },
    agentTranscript: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        insert(transcripts, transcriptKey, data, skipDuplicates),
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const found = transcripts.find((item) => matches(item, flat(where)));
        if (!found) {
          throw new Error('not found');
        }
        return clone(found);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        apply(
          transcripts.find((item) => item.id === where.id)!,
          data,
        );
        return {};
      }),
    },
    agentTranscriptCall: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        insert(calls, callKey, data, skipDuplicates),
      ),
      findMany: jest.fn(async ({ where }: any) =>
        clone(calls.filter((item) => matches(item, where))),
      ),
    },
    agentRunEvent: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        insert(runEvents, runStepKey, data, Boolean(skipDuplicates)),
      ),
      findMany: jest.fn(async (): Promise<Row[]> => []),
      deleteMany: jest.fn(),
    },
    agentSessionEvent: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) =>
        insert(sessionEvents, sessionStepKey, data, Boolean(skipDuplicates)),
      ),
      findMany: jest.fn(async (): Promise<Row[]> => []),
      deleteMany: jest.fn(),
    },
    $queryRaw: jest.fn(async (): Promise<Row[]> => []),
    $transaction: (work: (tx: unknown) => Promise<unknown>) => {
      const run: Promise<unknown> = queue.then(() => work(db));
      queue = run.catch((): undefined => undefined);
      return run;
    },
  };

  return {
    db,
    sessions,
    runs,
    transcripts,
    calls,
    runEvents,
    sessionEvents,
    service: new SessionActivityService(db as unknown as PrismaService),
  };
}

const issueRow = (fake: ReturnType<typeof fakeDb>, key: string) =>
  fake.sessions.find((item) => item.issueId === `issue-${key}`)!;

describe('SessionActivityService', () => {
  it('refuses a body that is not a uuid, a list, or a child path', async () => {
    const { service, calls } = fakeDb({ sessions: [row('s1', 'ENG-1', 0)] });

    await expect(
      service.apply(peer, { externalId: 'x', entries: [] }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      service.apply(peer, { externalId: ID, entries: 'no' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      service.apply(peer, { externalId: ID, entries: new Array(501).fill({}) }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      service.apply(peer, {
        externalId: ID,
        sourceSessionId: '../secret',
        entries: [assistant(1000, 0.5)],
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("looks only at the person's own sessions, and records nothing for another's", async () => {
    const fake = fakeDb({ sessions: [] });

    await expect(
      fake.service.apply(peer, {
        externalId: ID,
        entries: [assistant(1000, 0.5)],
      }),
    ).resolves.toEqual({ ok: true });

    const where = (fake.db.agentSession.findMany.mock.calls as any[][])[0][0]
      .where;
    expect(where).toMatchObject({
      workspaceId: 'ws-1',
      externalId: { in: [ID, `omp:${ID}`] },
      OR: [{ actorUserId: 'user-1' }, { agentRun: { createdById: 'user-1' } }],
    });
    expect(fake.transcripts).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('records a replayed batch once: the same calls, and the same money and turns', async () => {
    const fake = fakeDb({ sessions: [row('s1', 'ENG-1', 0)] });
    const batch = [user(500, 'Fix it'), assistant(1000, 0.5)];

    await fake.service.apply(peer, { externalId: ID, entries: batch });
    const first = {
      cost: issueRow(fake, 'ENG-1').terminalCostUsd,
      turns: issueRow(fake, 'ENG-1').terminalTurns,
    };

    // The connector lost the acknowledgement and sends the same batch again,
    // with the final assistant message repeated at the same timestamp.
    await fake.service.apply(peer, { externalId: ID, entries: batch });
    await Promise.all([
      fake.service.apply(peer, { externalId: ID, entries: batch }),
      fake.service.apply(peer, { externalId: ID, entries: batch }),
    ]);

    expect(issueRow(fake, 'ENG-1')).toMatchObject({
      terminalCostUsd: first.cost,
      terminalTurns: first.turns,
    });
    expect(fake.transcripts[0]).toMatchObject({
      knownCostUsd: 0.5,
      unknownCallCount: 0,
    });
    expect(fake.calls.filter((item) => item.kind === 'call')).toHaveLength(1);
  });

  it('splits a session between two linked issues, so neither receives the whole total', async () => {
    const fake = fakeDb({
      sessions: [row('a', 'ENG-1', 0), row('b', 'ENG-2', 5000)],
    });

    await fake.service.apply(peer, {
      externalId: ID,
      entries: [assistant(2000, 0.5), assistant(6000, 0.25)],
    });

    expect(issueRow(fake, 'ENG-1').terminalCostUsd).toBeCloseTo(0.5);
    expect(issueRow(fake, 'ENG-2').terminalCostUsd).toBeCloseTo(0.25);
    const transcript = fake.transcripts[0];
    const shares =
      issueRow(fake, 'ENG-1').terminalCostUsd +
      issueRow(fake, 'ENG-2').terminalCostUsd;
    expect(shares + transcript.unattributedCostUsd).toBeCloseTo(
      transcript.knownCostUsd,
    );
  });

  it("attributes a child's calls to the issue its root was on when the child started, even after the root moved on", async () => {
    const fake = fakeDb({
      sessions: [row('a', 'ENG-1', 0), row('b', 'ENG-2', 0)],
    });
    const child = {
      externalId: ID,
      sourceSessionId: 'agent-1',
      sourceStartedAt: at(3500),
      entries: [assistant(3600, 0.4), assistant(3800, 0.1)],
    };

    // The root works on ENG-1 and spawns the child, then goes idle. Its last
    // entry comes before the child starts, and no later marker follows.
    await fake.service.apply(peer, {
      externalId: ID,
      entries: [
        pickup(1000, 'ENG-1'),
        assistant(2000, 0.5),
        assistant(3000, 0.2),
      ],
    });

    // The child starts after its parent's last entry. It is recorded at once,
    // on the issue that was current at its start, and nothing is held back.
    await expect(fake.service.apply(peer, child)).resolves.toEqual({
      ok: true,
    });
    expect(
      fake.calls.filter((item) => item.sourceSessionId === 'agent-1'),
    ).toHaveLength(2);
    // It then switches to ENG-2 before the child's batch arrives.
    await fake.service.apply(peer, {
      externalId: ID,
      entries: [pickup(5000, 'ENG-2'), assistant(6000, 0.3)],
    });

    await expect(fake.service.apply(peer, child)).resolves.toEqual({
      ok: true,
    });
    await expect(fake.service.apply(peer, child)).resolves.toEqual({
      ok: true,
    });

    expect(issueRow(fake, 'ENG-1').terminalCostUsd).toBeCloseTo(
      0.5 + 0.2 + 0.4 + 0.1,
    );
    expect(issueRow(fake, 'ENG-2').terminalCostUsd).toBeCloseTo(0.3);
    expect(fake.transcripts[0].knownCostUsd).toBeCloseTo(1.5);
    expect(fake.transcripts[0].unattributedCostUsd).toBeCloseTo(0);
    expect(
      fake.calls.filter((item) => item.sourceSessionId === 'agent-1'),
    ).toHaveLength(2);
  });

  it('counts an external Claude result once and a mirror of an assistant call not at all', async () => {
    const fake = fakeDb({ sessions: [row('a', 'ENG-1', 0)] });
    const entries = [
      assistant(1000, 0.03),
      // The provider's own record of the same request.
      {
        type: 'model_usage',
        id: 'm1000',
        timestamp: at(1000),
        responseId: 'r1000',
        usage: { cost: { total: 0.03 } },
      },
      // An auxiliary request that omp makes for itself.
      {
        type: 'model_usage',
        id: 'u1500',
        timestamp: at(1500),
        purpose: 'title',
        responseId: 'rt',
        usage: { cost: { total: 0.001 } },
      },
      // The external Claude result: its delta, not its cumulative total.
      {
        type: 'message',
        id: 'd2000',
        timestamp: at(2000),
        message: {
          role: 'toolResult',
          toolName: 'claude_delegate',
          toolCallId: 'inv-1',
          details: {
            kind: 'claude-delegate',
            invocationId: 'inv-1',
            billing: {
              mode: 'subscription',
              costBasis: 'list',
              apiEquivalentUsd: 0.09,
              deltaApiEquivalentUsd: 0.02,
              cumulative: true,
            },
          },
        },
      },
    ];

    await fake.service.apply(peer, { externalId: ID, entries });
    await fake.service.apply(peer, { externalId: ID, entries });

    expect(issueRow(fake, 'ENG-1').terminalCostUsd).toBeCloseTo(
      0.03 + 0.001 + 0.02,
    );
    expect(issueRow(fake, 'ENG-1').terminalTurns).toBe(1);
    // The assistant and the title request name no provider, so their amounts
    // are harness estimates of an unknown billing mode, and the delegate's is a list price.
    const summary = fake.transcripts[0].billingSummary;
    expect(summary['subscription/list']).toMatchObject({
      pricedCalls: 1,
    });
    expect(summary['subscription/list'].costUsd).toBeCloseTo(0.02);
    expect(summary['unknown/harness_estimate']).toMatchObject({
      pricedCalls: 2,
    });
    expect(summary['unknown/harness_estimate'].costUsd).toBeCloseTo(0.031);
  });

  it('counts a call with no known amount as unknown, never as $0', async () => {
    const fake = fakeDb({ sessions: [row('a', 'ENG-1', 0)] });

    await fake.service.apply(peer, {
      externalId: ID,
      entries: [assistant(1000, 0.5), assistant(2000, null)],
    });

    expect(issueRow(fake, 'ENG-1')).toMatchObject({
      terminalCostUsd: 0.5,
      terminalUnknownCalls: 1,
      terminalTurns: 2,
    });
    expect(fake.transcripts[0]).toMatchObject({
      knownCostUsd: 0.5,
      unknownCallCount: 1,
    });
  });

  it("counts a run's own work once, in the run, and only the terminal work after it finished", async () => {
    const fake = fakeDb({
      sessions: [
        row('r', 'ENG-1', 0, {
          agentRunId: 'run-1',
          agentRun: { finishedAt: new Date(BASE + 2000) },
        }),
      ],
      runs: [{ id: 'run-1', result: { costUsd: 1, turns: 4 } }],
    });

    await fake.service.apply(peer, {
      externalId: ID,
      entries: [
        user(1000, 'the run'),
        assistant(1500, 0.5),
        user(2500, 'and then me'),
        assistant(3000, 0.25),
      ],
    });

    expect(fake.runs[0].result).toEqual({ costUsd: 1.25, turns: 5 });
    expect(issueRow(fake, 'ENG-1').terminalCostUsd).toBeCloseTo(0.25);
    expect(fake.transcripts[0].knownCostUsd).toBeCloseTo(0.25);
  });

  it('records nothing of a run that has not finished', async () => {
    const fake = fakeDb({
      sessions: [
        row('r', 'ENG-1', 0, {
          agentRunId: 'run-1',
          agentRun: { finishedAt: null },
        }),
      ],
      runs: [{ id: 'run-1', result: { costUsd: 1, turns: 4 } }],
    });

    await fake.service.apply(peer, {
      externalId: ID,
      entries: [user(2500, 'x'), assistant(3000, 0.25)],
    });

    expect(fake.runs[0].result).toEqual({ costUsd: 1, turns: 4 });
    expect(fake.calls).toEqual([]);
    expect(fake.runEvents).toEqual([]);
  });

  it('keeps the steps of a session without a run in its own events', async () => {
    const fake = fakeDb({ sessions: [row('s2', 'ENG-1', 0)] });

    await fake.service.apply(peer, {
      externalId: ID,
      entries: [user(1000, 'Fix it'), assistant(2000, 0.5)],
    });

    expect(fake.db.agentSessionEvent.createMany).toHaveBeenCalledTimes(1);
    expect(fake.db.agentRunEvent.createMany).not.toHaveBeenCalled();
  });

  it('writes a replayed step once, keeps entries at the same instant apart, and writes each step only to its own issue', async () => {
    const fake = fakeDb({
      sessions: [row('a', 'ENG-1', 0), row('b', 'ENG-2', 5000)],
    });
    // Two different entries at the same millisecond: each has its own id.
    const second = { ...user(1000, 'second, same instant'), id: 'u1000-b' };
    const batch = [user(1000, 'first for A'), second, user(6000, 'for B')];

    await fake.service.apply(peer, { externalId: ID, entries: batch });
    await fake.service.apply(peer, { externalId: ID, entries: batch });
    // And a retry that arrives at the same time as the first.
    await Promise.all([
      fake.service.apply(peer, { externalId: ID, entries: batch }),
      fake.service.apply(peer, { externalId: ID, entries: batch }),
    ]);

    const messages = (sessionId: string) =>
      fake.sessionEvents
        .filter((item) => item.sessionId === sessionId)
        .map((item) => item.message);
    expect(messages('a')).toEqual(['first for A', 'second, same instant']);
    expect(messages('b')).toEqual(['for B']);
  });

  it('keeps the totals a row held before the record as a baseline, apart from the ledger', async () => {
    const fake = fakeDb({
      sessions: [
        row('a', 'ENG-1', 0, { terminalCostUsd: 2, terminalTurns: 4 }),
      ],
    });

    await fake.service.apply(peer, {
      externalId: ID,
      entries: [assistant(2000, 0.5)],
    });

    expect(fake.transcripts[0].sources.main).toMatchObject({
      legacyTotals: true,
      legacyBaseline: {
        'issue-ENG-1': { costUsd: 2, turns: 4, unknownCalls: 0 },
      },
    });
    // The ledger counts only what it claimed.
    expect(fake.transcripts[0].knownCostUsd).toBeCloseTo(0.5);
  });

  it('keeps work on the picked-up issue across writes to unlinked issues, and switches on a linked write', async () => {
    const write = (ms: number, tool: string, task: string) =>
      assistant(ms, 0, [
        {
          type: 'toolCall',
          id: `w${ms}`,
          name: `mcp__vantik_${tool}`,
          arguments: { task },
        },
      ]);
    const fake = fakeDb({
      sessions: [row('a', 'ENG-1', 0), row('b', 'ENG-2', 0)],
    });
    const first = [
      pickup(1000, 'ENG-1'),
      assistant(2000, 0.5),
      // A note on an issue that this session is not linked to.
      write(3000, 'add_note', 'ENG-9'),
      assistant(4000, 0.25),
    ];
    const second = [assistant(5000, 0.1)];

    await fake.service.apply(peer, { externalId: ID, entries: first });
    await fake.service.apply(peer, { externalId: ID, entries: second });
    // A replay of both batches adds nothing and moves nothing.
    await fake.service.apply(peer, { externalId: ID, entries: first });
    await fake.service.apply(peer, { externalId: ID, entries: second });

    expect(issueRow(fake, 'ENG-1').terminalCostUsd).toBeCloseTo(0.85);
    expect(issueRow(fake, 'ENG-2').terminalCostUsd).toBeCloseTo(0);
    expect(fake.transcripts[0].unattributedCostUsd).toBeCloseTo(0);

    // A linked write to B is the work moving to B.
    await fake.service.apply(peer, {
      externalId: ID,
      entries: [write(6000, 'update_task', 'ENG-2'), assistant(7000, 0.3)],
    });

    expect(issueRow(fake, 'ENG-1').terminalCostUsd).toBeCloseTo(0.85);
    expect(issueRow(fake, 'ENG-2').terminalCostUsd).toBeCloseTo(0.3);
  });
});
