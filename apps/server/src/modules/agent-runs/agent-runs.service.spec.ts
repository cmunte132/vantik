/**
 * The agent run status machine.
 *
 * Every state change in the system goes through `transition`, so this table is
 * the whole of the lifecycle's correctness. The cases that matter are not the
 * happy path — they are the ones where a runner writes what it believes rather
 * than what is true: a report arriving for a run the sweeper already expired,
 * two backends claiming the same queued run, a cancel racing a completion.
 *
 * Every rejected transition is asserted, not a sample of them. A table like
 * this rots by gaining an entry nobody meant to add, and a test that checks
 * only the pairs someone thought of will not notice.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  AGENT_RUN_STATUSES,
  AGENT_RUN_TRANSITIONS,
  type AgentRunStatus,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { AgentRunsService } from './agent-runs.service';

const WORKSPACE = 'workspace-mine';
const RUN = 'run-1';

interface FakeRun {
  id: string;
  workspaceId: string;
  issueId: string;
  agentUserId: string;
  createdById: string | null;
  executor: string;
  status: AgentRunStatus;
  attempt: number;
  previousRunId: string | null;
  leaseExpiresAt: Date | null;
  finishedAt: Date | null;
  failure: string | null;
  config: unknown;
  contextPack: unknown;
  configHash: string | null;
  deleted: Date | null;
}

function makeRun(over: Partial<FakeRun> = {}): FakeRun {
  return {
    id: RUN,
    workspaceId: WORKSPACE,
    issueId: 'issue-1',
    agentUserId: 'agent-1',
    createdById: 'user-1',
    executor: 'byo',
    status: 'QUEUED',
    attempt: 1,
    previousRunId: null,
    leaseExpiresAt: null,
    finishedAt: null,
    failure: null,
    config: null,
    contextPack: null,
    configHash: null,
    deleted: null,
    ...over,
  };
}

/**
 * An in-memory stand-in for the rows the service touches. `updateMany` honours
 * the status predicate, which is the part under test: the conditional update
 * is what makes a lost race visible instead of silent.
 */
function buildService(initial: FakeRun[] = [makeRun()]) {
  const rows = new Map(initial.map((run) => [run.id, { ...run }]));
  const events: Array<Record<string, unknown>> = [];
  let created = 0;

  /**
   * Enough of Prisma's `where` grammar for the predicates this service builds:
   * scalars, `in`, and the `{ not, lt }` the lease sweep uses.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matches = (run: FakeRun, where: any) =>
    Object.entries(where).every(([key, condition]) => {
      const actual = (run as never as Record<string, unknown>)[key];

      if (condition === null || condition === undefined) {
        return actual == null;
      }

      if (typeof condition === 'object' && !(condition instanceof Date)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const operators = condition as Record<string, any>;
        return Object.entries(operators).every(([operator, operand]) => {
          switch (operator) {
            case 'in':
              return (operand as unknown[]).includes(actual);
            case 'not':
              return operand === null ? actual != null : actual !== operand;
            case 'lt':
              return actual != null && (actual as Date) < operand;
            case 'gt':
              return actual != null && (actual as Date) > operand;
            default:
              throw new Error(`fake prisma: unsupported operator ${operator}`);
          }
        });
      }

      return actual === condition;
    });

  // Reads hand back copies, as a real database does. Returning the live object
  // would let a test mutate the very snapshot the service is reasoning about,
  // which hides exactly the races these tests exist to check.
  const copy = (run?: FakeRun) => (run ? { ...run } : null);

  const prisma = {
    agentRun: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          copy(
            where.id
              ? rows.get(where.id)
              : [...rows.values()].find(
                  (run) => run.previousRunId === where.previousRunId,
                ),
          ),
        ),
      ),
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(
          copy([...rows.values()].find((run) => matches(run, where))),
        ),
      ),
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          [...rows.values()]
            .filter((run) => matches(run, where))
            .map((run) => ({ ...run })),
        ),
      ),
      count: jest.fn(() => Promise.resolve(rows.size)),
      updateMany: jest.fn(({ where, data }) => {
        const hit = [...rows.values()].filter((run) => matches(run, where));
        for (const run of hit) {
          Object.assign(run, data);
        }
        return Promise.resolve({ count: hit.length });
      }),
      create: jest.fn(({ data }) => {
        created += 1;
        const run = makeRun({ ...data, id: `run-new-${created}` });
        rows.set(run.id, run);
        return Promise.resolve(run);
      }),
    },
    agentRunEvent: {
      create: jest.fn(({ data }) => {
        events.push(data);
        return Promise.resolve({ id: `event-${events.length}`, ...data });
      }),
      count: jest.fn(() => Promise.resolve(events.length)),
      findMany: jest.fn(() => Promise.resolve([])),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
  } as unknown as PrismaService;

  return { service: new AgentRunsService(prisma), rows, events, prisma };
}

const scope = { workspaceId: WORKSPACE };

describe('AgentRunsService transition table', () => {
  // The whole cross product, so an entry added to the table without thought
  // fails here rather than shipping.
  const pairs = AGENT_RUN_STATUSES.flatMap((from) =>
    AGENT_RUN_STATUSES.filter((to) => to !== from).map((to) => ({ from, to })),
  );

  const legal = pairs.filter(({ from, to }) =>
    AGENT_RUN_TRANSITIONS[from].includes(to),
  );
  const illegal = pairs.filter(
    ({ from, to }) => !AGENT_RUN_TRANSITIONS[from].includes(to),
  );

  it.each(legal)('allows $from → $to', async ({ from, to }) => {
    const { service, rows } = buildService([makeRun({ status: from })]);

    await service.transition(RUN, to, {}, scope);

    expect(rows.get(RUN)?.status).toBe(to);
  });

  it.each(illegal)('refuses $from → $to', async ({ from, to }) => {
    const { service, rows } = buildService([makeRun({ status: from })]);

    await expect(service.transition(RUN, to, {}, scope)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Refusing must not have written anything on the way to refusing.
    expect(rows.get(RUN)?.status).toBe(from);
  });

  it('treats a repeat of the current status as a no-op, not an error', async () => {
    const { service, prisma } = buildService([makeRun({ status: 'RUNNING' })]);

    await expect(
      service.transition(RUN, 'RUNNING', {}, scope),
    ).resolves.toMatchObject({ status: 'RUNNING' });
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalled();
  });

  it('stops the clock and drops the lease on any terminal state', async () => {
    const { service, rows } = buildService([
      makeRun({
        status: 'RUNNING',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ]);

    await service.transition(RUN, 'SUCCEEDED', {}, scope);

    // A lease left on a finished run keeps the sweeper finding it for ever.
    expect(rows.get(RUN)?.leaseExpiresAt).toBeNull();
    expect(rows.get(RUN)?.finishedAt).toBeInstanceOf(Date);
  });

  it('tells a loser of a race what actually happened', async () => {
    const { service, rows } = buildService([makeRun({ status: 'RUNNING' })]);

    // Someone else cancels between this caller's read and its write.
    const raced = service.transition(RUN, 'SUCCEEDED', {}, scope);
    rows.get(RUN).status = 'CANCELED';

    await expect(raced).rejects.toThrow(/moved to CANCELED/);
  });

  it('names the legal moves when it refuses a live run', async () => {
    const { service } = buildService([makeRun({ status: 'QUEUED' })]);

    await expect(service.transition(RUN, 'SUCCEEDED', {}, scope)).rejects.toThrow(
      /From QUEUED it may become: CLAIMED, CANCELED, FAILED/,
    );
  });

  it('says a finished run is finished rather than listing nothing', async () => {
    const { service } = buildService([makeRun({ status: 'SUCCEEDED' })]);

    await expect(service.transition(RUN, 'RUNNING', {}, scope)).rejects.toThrow(
      /already finished as SUCCEEDED/,
    );
  });
});

describe('AgentRunsService leases', () => {
  it('refuses a heartbeat on a run that was cancelled underneath it', async () => {
    const { service } = buildService([makeRun({ status: 'CANCELED' })]);

    // How a runner learns to stop: it finds out on its next heartbeat rather
    // than after another hour of work nobody wants.
    await expect(service.heartbeat(RUN, scope)).rejects.toThrow(/Stop work/);
  });

  it('renews without changing status', async () => {
    const { service, rows } = buildService([makeRun({ status: 'RUNNING' })]);

    await service.heartbeat(RUN, scope);

    expect(rows.get(RUN)?.status).toBe('RUNNING');
    expect(rows.get(RUN)?.leaseExpiresAt?.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('expires a lapsed lease and re-queues it as the next attempt', async () => {
    const { service, rows } = buildService([
      makeRun({
        status: 'RUNNING',
        attempt: 1,
        leaseExpiresAt: new Date(Date.now() - 1000),
      }),
    ]);

    const { expired, requeued } = await service.expireLapsedLeases();

    expect({ expired, requeued }).toEqual({ expired: 1, requeued: 1 });
    expect(rows.get(RUN)?.status).toBe('EXPIRED');
    // Typed, so "the runner went away" is countable rather than a string.
    expect(rows.get(RUN)?.failure).toBe('LEASE_LOST');

    const retry = [...rows.values()].find((run) => run.previousRunId === RUN);
    expect(retry).toMatchObject({ status: 'QUEUED', attempt: 2 });
  });

  it('stops re-queueing at the attempt cap', async () => {
    const { service, rows } = buildService([
      makeRun({
        status: 'RUNNING',
        attempt: 3,
        leaseExpiresAt: new Date(Date.now() - 1000),
      }),
    ]);

    const { expired, requeued } = await service.expireLapsedLeases();

    // The same environment failing the same way a fourth time is not new
    // information, and it costs model budget to learn nothing.
    expect({ expired, requeued }).toEqual({ expired: 1, requeued: 0 });
    expect(rows.get(RUN)?.status).toBe('EXPIRED');
  });

  it('leaves a run alone when its lease has not lapsed', async () => {
    const { service, rows } = buildService([
      makeRun({
        status: 'RUNNING',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ]);

    await expect(service.expireLapsedLeases()).resolves.toEqual({
      expired: 0,
      requeued: 0,
    });
    expect(rows.get(RUN)?.status).toBe('RUNNING');
  });
});

describe('AgentRunsService retry', () => {
  it('opens a new attempt rather than mutating the old record', async () => {
    const { service, rows } = buildService([
      makeRun({ status: 'FAILED', attempt: 1 }),
    ]);

    const retry = await service.retryRun(RUN, scope, 'user-1');

    // The failed attempt is evidence. Overwriting it is how you end up unable
    // to say why the third attempt failed the same way as the first.
    expect(rows.get(RUN)?.status).toBe('FAILED');
    expect(retry).toMatchObject({
      status: 'QUEUED',
      attempt: 2,
      previousRunId: RUN,
    });
  });

  it('carries the original config and context pack forward', async () => {
    const { service } = buildService([
      makeRun({
        status: 'EXPIRED',
        config: { baseBranch: 'main' },
        contextPack: { title: 'Fix the thing' },
      }),
    ]);

    const retry = await service.retryRun(RUN, scope, 'user-1');

    expect(retry).toMatchObject({
      config: { baseBranch: 'main' },
      contextPack: { title: 'Fix the thing' },
    });
  });

  it('refuses to retry work that succeeded', async () => {
    const { service } = buildService([makeRun({ status: 'SUCCEEDED' })]);

    // Would produce a second PR for an issue that already has one.
    await expect(service.retryRun(RUN, scope, 'user-1')).rejects.toThrow(
      /would duplicate work/,
    );
  });

  it('refuses to retry work someone deliberately stopped', async () => {
    const { service } = buildService([makeRun({ status: 'CANCELED' })]);

    await expect(service.retryRun(RUN, scope, 'user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('asks for a cancel before retrying something still running', async () => {
    const { service } = buildService([makeRun({ status: 'RUNNING' })]);

    await expect(service.retryRun(RUN, scope, 'user-1')).rejects.toThrow(
      /Cancel it before retrying/,
    );
  });

  it('refuses past the attempt cap with advice rather than a bare no', async () => {
    const { service } = buildService([
      makeRun({ status: 'FAILED', attempt: 3 }),
    ]);

    await expect(service.retryRun(RUN, scope, 'user-1')).rejects.toThrow(
      /broken configuration rather than bad luck/,
    );
  });

  it('refuses to fork a chain that was already retried', async () => {
    const { service } = buildService([
      makeRun({ status: 'FAILED' }),
      makeRun({ id: 'run-2', status: 'QUEUED', attempt: 2, previousRunId: RUN }),
    ]);

    await expect(service.retryRun(RUN, scope, 'user-1')).rejects.toThrow(
      /already been retried/,
    );
  });

  it('lets a human retry a run routed to review', async () => {
    const { service } = buildService([makeRun({ status: 'NEEDS_REVIEW' })]);

    await expect(
      service.retryRun(RUN, scope, 'user-1'),
    ).resolves.toMatchObject({ status: 'QUEUED', attempt: 2 });
  });
});

describe('AgentRunsService events', () => {
  it('refuses an event for a run that already finished', async () => {
    const { service, events } = buildService([
      makeRun({ status: 'SUCCEEDED' }),
    ]);

    await expect(
      service.appendEvent(RUN, { message: 'late' }, scope),
    ).rejects.toThrow(/accepts no more events/);
    expect(events).toHaveLength(0);
  });

  it('defaults the level and timestamps on arrival', async () => {
    const { service, events } = buildService([makeRun({ status: 'RUNNING' })]);

    await service.appendEvent(RUN, { message: 'cloning' }, scope);

    expect(events[0]).toMatchObject({ message: 'cloning', level: 'INFO' });
    expect(events[0].at).toBeInstanceOf(Date);
  });

  it('honours a timestamp the executor supplies', async () => {
    const { service, events } = buildService([makeRun({ status: 'RUNNING' })]);

    // A runner batching events must be able to say when each happened, or a
    // burst all lands at the same instant and the tail reads out of order.
    await service.appendEvent(
      RUN,
      { message: 'ran tests', at: '2026-07-26T10:00:00.000Z' },
      scope,
    );

    expect((events[0].at as Date).toISOString()).toBe(
      '2026-07-26T10:00:00.000Z',
    );
  });
});

describe('AgentRunsService tenancy', () => {
  it('does not find a run from another workspace', async () => {
    const { service } = buildService([
      makeRun({ workspaceId: 'workspace-theirs' }),
    ]);

    await expect(
      service.getRun(RUN, { workspaceId: WORKSPACE }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes every list to the caller’s workspace', async () => {
    const { service, prisma } = buildService();

    await service.listRuns({}, { workspaceId: WORKSPACE });

    expect(
      (prisma.agentRun.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ workspaceId: WORKSPACE, deleted: null });
  });

  it('shows an agent its own runs and no others', async () => {
    const { service, prisma } = buildService();

    await service.listRuns(
      {},
      { workspaceId: WORKSPACE, onlyAgentUserId: 'agent-1' },
    );

    // An agent that can enumerate the workspace's runs can enumerate its
    // issues through them.
    expect(
      (prisma.agentRun.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ agentUserId: 'agent-1' });
  });

  it('hides another agent’s run behind the same 404 as a missing one', async () => {
    const { service } = buildService([makeRun({ agentUserId: 'agent-2' })]);

    await expect(
      service.getRun(RUN, {
        workspaceId: WORKSPACE,
        onlyAgentUserId: 'agent-1',
      }),
    ).rejects.toThrow(`Agent run ${RUN} not found`);
  });

  it('refuses to cancel a run in another workspace', async () => {
    const { service, rows } = buildService([
      makeRun({ workspaceId: 'workspace-theirs', status: 'RUNNING' }),
    ]);

    await expect(
      service.cancelRun(RUN, { workspaceId: WORKSPACE }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows.get(RUN)?.status).toBe('RUNNING');
  });

  it('refuses to append an event to a run in another workspace', async () => {
    const { service, events } = buildService([
      makeRun({ workspaceId: 'workspace-theirs', status: 'RUNNING' }),
    ]);

    await expect(
      service.appendEvent(RUN, { message: 'injected' }, { workspaceId: WORKSPACE }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(events).toHaveLength(0);
  });

  it('refuses to read the events of a run in another workspace', async () => {
    const { service } = buildService([
      makeRun({ workspaceId: 'workspace-theirs' }),
    ]);

    await expect(
      service.listEvents(RUN, { workspaceId: WORKSPACE }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to retry a run in another workspace', async () => {
    const { service, prisma } = buildService([
      makeRun({ workspaceId: 'workspace-theirs', status: 'FAILED' }),
    ]);

    await expect(
      service.retryRun(RUN, { workspaceId: WORKSPACE }, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.agentRun.create).not.toHaveBeenCalled();
  });
});
