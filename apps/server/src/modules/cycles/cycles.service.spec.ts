import {
  CycleHistoryChangeEnum,
  CycleStatusEnum,
  UnfinishedDestinationEnum,
} from '@vantikhq/types';

import { CyclesService } from './cycles.service';

/**
 * The seeder's contract that reading it does not make obvious: which cycle the
 * team pointer ends up on. It used to be pinned to 1, so re-seeding a team that
 * had already run cycles sent it at a cycle closed months ago while the new
 * batch started well past it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function buildPrisma(latestCycle: { number: number } | null = null) {
  return {
    team: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ preferences: { cyclesFrequency: 2 } }),
      update: jest.fn().mockImplementation((args: any) => args.data),
    },
    cycle: {
      findFirst: jest.fn().mockResolvedValue(latestCycle),
      create: jest.fn().mockImplementation((args: any) => args.data),
    },
    $transaction: jest.fn().mockImplementation((calls: any[]) => calls),
  };
}

function serviceWith(prisma: any) {
  return new CyclesService(prisma);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('CyclesService.createCycles', () => {
  it('points a fresh team at its first cycle', async () => {
    const prisma = buildPrisma();

    await serviceWith(prisma).createCycles('team-1');

    expect(prisma.team.update.mock.calls[0][0].data.currentCycle).toBe(1);
  });

  it('points a re-seeded team at the first cycle of the new batch', async () => {
    const prisma = buildPrisma({ number: 12 });

    await serviceWith(prisma).createCycles('team-1');

    expect(prisma.team.update.mock.calls[0][0].data.currentCycle).toBe(13);
  });

  it('continues numbering from the last existing cycle', async () => {
    const prisma = buildPrisma({ number: 12 });

    await serviceWith(prisma).createCycles('team-1');

    const numbers = prisma.cycle.create.mock.calls.map(
      (call) => call[0].data.number,
    );
    expect(numbers).toEqual([13, 14, 15]);
  });

  it('makes only the first cycle of the batch current', async () => {
    const prisma = buildPrisma({ number: 12 });

    await serviceWith(prisma).createCycles('team-1');

    const statuses = prisma.cycle.create.mock.calls.map(
      (call) => call[0].data.status,
    );
    expect(statuses).toEqual([
      CycleStatusEnum.CURRENT,
      CycleStatusEnum.UPCOMING,
      CycleStatusEnum.UPCOMING,
    ]);
  });
});

/**
 * Completion is the operation both modes route through, and the one with the
 * most ways to be quietly wrong: finished issues dragged along with the
 * unfinished ones, history not written so a burnup cannot explain where the
 * work went, or a team left pointing at a cycle that is not there.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function buildCompletionPrisma({
  cycle = {
    id: 'cycle-1',
    teamId: 'team-1',
    number: 4,
    name: 'Cycle 4',
    status: CycleStatusEnum.CURRENT,
  },
  nextCycle = { id: 'cycle-2', number: 5 },
  unfinishedIssues = [{ id: 'issue-1', stateId: 'state-todo', estimate: 3 }],
}: any = {}) {
  return {
    cycle: {
      findFirst: jest
        .fn()
        .mockImplementation((args: any) =>
          args.where.number === undefined
            ? Promise.resolve(cycle)
            : Promise.resolve(nextCycle),
        ),
      findUnique: jest.fn().mockResolvedValue(cycle),
      update: jest.fn().mockImplementation((args: any) => args),
    },
    workflow: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'state-done' }, { id: 'state-cancelled' }]),
    },
    issue: {
      findMany: jest.fn().mockResolvedValue(unfinishedIssues),
      update: jest.fn().mockImplementation((args: any) => args),
      updateMany: jest.fn().mockImplementation((args: any) => args),
    },
    cycleHistory: {
      create: jest.fn().mockImplementation((args: any) => args),
      createMany: jest.fn().mockImplementation((args: any) => args),
    },
    team: {
      update: jest.fn().mockImplementation((args: any) => args),
    },
    $transaction: jest.fn().mockImplementation((calls: any[]) => calls),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('CyclesService.completeCycle', () => {
  it('moves unfinished issues into the next cycle', async () => {
    const prisma = buildCompletionPrisma();

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.NEXT_CYCLE,
    });

    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['issue-1'] } },
      data: { cycleId: 'cycle-2' },
    });
  });

  it('sends unfinished issues to the backlog when asked', async () => {
    const prisma = buildCompletionPrisma();

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.BACKLOG,
    });

    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['issue-1'] } },
      data: { cycleId: null },
    });
  });

  it('asks only for issues in states the team does not count as finished', async () => {
    const prisma = buildCompletionPrisma();

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.BACKLOG,
    });

    expect(prisma.workflow.findMany.mock.calls[0][0].where).toMatchObject({
      teamId: 'team-1',
      category: { in: ['COMPLETED', 'CANCELED'] },
    });
    expect(prisma.issue.findMany.mock.calls[0][0].where).toMatchObject({
      cycleId: 'cycle-1',
      stateId: { notIn: ['state-done', 'state-cancelled'] },
    });
  });

  it('leaves finished issues where they are', async () => {
    const prisma = buildCompletionPrisma({ unfinishedIssues: [] });

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.NEXT_CYCLE,
    });

    expect(prisma.issue.updateMany).not.toHaveBeenCalled();
    expect(prisma.cycleHistory.createMany).not.toHaveBeenCalled();
  });

  it('moves every issue in one statement rather than one each', async () => {
    // A cycle carrying hundreds of unfinished issues used to build 2n+3
    // statements for a single interactive transaction and exceed Prisma's 5s
    // default, so the completion rolled back and the cycle could never close.
    const unfinishedIssues = Array.from({ length: 250 }, (_, index) => ({
      id: `issue-${index}`,
      stateId: 'state-todo',
      estimate: 1,
    }));
    const prisma = buildCompletionPrisma({ unfinishedIssues });

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.BACKLOG,
    });

    expect(prisma.issue.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.cycleHistory.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.cycleHistory.createMany.mock.calls[0][0].data).toHaveLength(
      250,
    );
    // Close the cycle, move the issues, write their history, promote the
    // successor, move the pointer — five, whatever the issue count.
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(5);
  });

  it('records where each moved issue went', async () => {
    const prisma = buildCompletionPrisma();

    await serviceWith(prisma).completeCycle(
      'cycle-1',
      { unfinishedDestination: UnfinishedDestinationEnum.NEXT_CYCLE },
      'user-1',
    );

    expect(prisma.cycleHistory.createMany.mock.calls[0][0].data[0]).toMatchObject(
      {
        cycleId: 'cycle-1',
        issueId: 'issue-1',
        userId: 'user-1',
        changeType: CycleHistoryChangeEnum.MOVED,
      },
    );
  });

  it('records a removal when the work goes back to the backlog', async () => {
    const prisma = buildCompletionPrisma();

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.BACKLOG,
    });

    expect(
      prisma.cycleHistory.createMany.mock.calls[0][0].data[0].changeType,
    ).toBe(CycleHistoryChangeEnum.REMOVED);
  });

  it('promotes the next cycle and follows it with the team pointer', async () => {
    const prisma = buildCompletionPrisma();

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.NEXT_CYCLE,
    });

    expect(prisma.cycle.update).toHaveBeenCalledWith({
      where: { id: 'cycle-2' },
      data: { status: CycleStatusEnum.CURRENT },
    });
    expect(prisma.team.update).toHaveBeenCalledWith({
      where: { id: 'team-1' },
      data: { currentCycle: 5 },
    });
  });

  it('nulls the pointer when the completed cycle was the last one', async () => {
    const prisma = buildCompletionPrisma({ nextCycle: null });

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.BACKLOG,
    });

    expect(prisma.team.update).toHaveBeenCalledWith({
      where: { id: 'team-1' },
      data: { currentCycle: null },
    });
  });

  it('leaves the pointer alone when the cycle completed was not the current one', async () => {
    // Completing a trailing upcoming cycle — which the schedule does when it
    // finds one past its end date — used to null `currentCycle` out from under
    // a sprint that was still running, and promote a successor into a second
    // CURRENT cycle beside it.
    const prisma = buildCompletionPrisma({
      cycle: {
        id: 'cycle-9',
        teamId: 'team-1',
        number: 9,
        name: 'Cycle 9',
        status: CycleStatusEnum.UPCOMING,
      },
      nextCycle: null,
    });

    await serviceWith(prisma).completeCycle('cycle-9', {
      unfinishedDestination: UnfinishedDestinationEnum.BACKLOG,
    });

    expect(prisma.team.update).not.toHaveBeenCalled();
  });

  it('does not promote a successor behind a cycle that was not current', async () => {
    const prisma = buildCompletionPrisma({
      cycle: {
        id: 'cycle-9',
        teamId: 'team-1',
        number: 9,
        name: 'Cycle 9',
        status: CycleStatusEnum.UPCOMING,
      },
    });

    await serviceWith(prisma).completeCycle('cycle-9', {
      unfinishedDestination: UnfinishedDestinationEnum.NEXT_CYCLE,
    });

    // The issues still move into it; it just does not become the team's
    // running cycle on the back of a completion that was not the current one.
    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['issue-1'] } },
      data: { cycleId: 'cycle-2' },
    });
    expect(prisma.cycle.update).not.toHaveBeenCalledWith({
      where: { id: 'cycle-2' },
      data: { status: CycleStatusEnum.CURRENT },
    });
  });

  it('looks for a successor that is upcoming, never one already completed', async () => {
    // Without the status filter this found whatever sat at the next number and
    // set a completed cycle back to CURRENT, closedAt and all.
    const prisma = buildCompletionPrisma();

    await serviceWith(prisma).completeCycle('cycle-1', {
      unfinishedDestination: UnfinishedDestinationEnum.NEXT_CYCLE,
    });

    const successorQuery = prisma.cycle.findFirst.mock.calls.find(
      (call: any) => call[0].where.number !== undefined,
    );
    expect(successorQuery[0].where).toMatchObject({
      number: 5,
      status: CycleStatusEnum.UPCOMING,
      deleted: null,
    });
  });

  it('refuses to move work into a next cycle that does not exist', async () => {
    const prisma = buildCompletionPrisma({ nextCycle: null });

    await expect(
      serviceWith(prisma).completeCycle('cycle-1', {
        unfinishedDestination: UnfinishedDestinationEnum.NEXT_CYCLE,
      }),
    ).rejects.toThrow(/no next cycle/i);

    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it('refuses to complete a cycle twice', async () => {
    const prisma = buildCompletionPrisma({
      cycle: {
        id: 'cycle-1',
        teamId: 'team-1',
        number: 4,
        name: 'Cycle 4',
        status: CycleStatusEnum.COMPLETED,
      },
    });

    await expect(
      serviceWith(prisma).completeCycle('cycle-1', {
        unfinishedDestination: UnfinishedDestinationEnum.BACKLOG,
      }),
    ).rejects.toThrow(/already complete/i);
  });
});

describe('CyclesService.startCycle', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function buildStartPrisma(cycleStatus: string, runningCycle: any = null) {
    const cycle = {
      id: 'cycle-2',
      teamId: 'team-1',
      number: 5,
      name: 'Cycle 5',
      status: cycleStatus,
    };

    return {
      cycle: {
        findFirst: jest
          .fn()
          .mockImplementation((args: any) =>
            args.where.status === CycleStatusEnum.CURRENT
              ? Promise.resolve(runningCycle)
              : Promise.resolve(cycle),
          ),
        update: jest.fn().mockImplementation((args: any) => args),
      },
      team: { update: jest.fn().mockImplementation((args: any) => args) },
      $transaction: jest.fn().mockImplementation((calls: any[]) => calls),
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('points the team at the cycle it starts', async () => {
    const prisma = buildStartPrisma(CycleStatusEnum.UPCOMING);

    await serviceWith(prisma).startCycle('cycle-2');

    expect(prisma.team.update).toHaveBeenCalledWith({
      where: { id: 'team-1' },
      data: { currentCycle: 5 },
    });
  });

  it('refuses a second current cycle for the team', async () => {
    const prisma = buildStartPrisma(CycleStatusEnum.UPCOMING, {
      name: 'Cycle 4',
    });

    await expect(serviceWith(prisma).startCycle('cycle-2')).rejects.toThrow(
      /Cycle 4 is still running/,
    );

    expect(prisma.cycle.update).not.toHaveBeenCalled();
  });

  it('refuses to restart a completed cycle', async () => {
    const prisma = buildStartPrisma(CycleStatusEnum.COMPLETED);

    await expect(serviceWith(prisma).startCycle('cycle-2')).rejects.toThrow(
      /Only an upcoming cycle can be started/,
    );
  });
});

describe('CyclesService.deleteCycle', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function buildDeletePrisma(status: string) {
    return {
      cycle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cycle-2',
          teamId: 'team-1',
          number: 5,
          name: 'Cycle 5',
          status,
        }),
        update: jest.fn().mockImplementation((args: any) => args),
      },
      issue: { updateMany: jest.fn().mockImplementation((args: any) => args) },
      $transaction: jest.fn().mockImplementation((calls: any[]) => calls),
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('detaches the issues rather than deleting them', async () => {
    const prisma = buildDeletePrisma(CycleStatusEnum.UPCOMING);

    await serviceWith(prisma).deleteCycle('cycle-2');

    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { cycleId: 'cycle-2', deleted: null },
      data: { cycleId: null },
    });
  });

  it('soft-deletes rather than dropping the row', async () => {
    const prisma = buildDeletePrisma(CycleStatusEnum.UPCOMING);

    await serviceWith(prisma).deleteCycle('cycle-2');

    expect(prisma.cycle.update.mock.calls[0][0].data.deleted).toBeInstanceOf(
      Date,
    );
  });

  it('refuses to delete a cycle a team has already run', async () => {
    const prisma = buildDeletePrisma(CycleStatusEnum.CURRENT);

    await expect(serviceWith(prisma).deleteCycle('cycle-2')).rejects.toThrow(
      /Only an upcoming cycle can be deleted/,
    );

    expect(prisma.issue.updateMany).not.toHaveBeenCalled();
  });
});

describe('CyclesService.createCycle', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function buildSinglePrisma(latestCycle: { number: number } | null) {
    return {
      cycle: {
        findFirst: jest.fn().mockResolvedValue(latestCycle),
        create: jest.fn().mockImplementation((args: any) => args.data),
      },
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const validCycle = {
    teamId: 'team-1',
    name: 'Sprint 1',
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-15T00:00:00.000Z',
  };

  it('continues the team numbering', async () => {
    const prisma = buildSinglePrisma({ number: 7 });

    await serviceWith(prisma).createCycle(validCycle);

    expect(prisma.cycle.create.mock.calls[0][0].data.number).toBe(8);
  });

  it('creates it upcoming, so starting it stays a deliberate act', async () => {
    const prisma = buildSinglePrisma(null);

    await serviceWith(prisma).createCycle(validCycle);

    expect(prisma.cycle.create.mock.calls[0][0].data.status).toBe(
      CycleStatusEnum.UPCOMING,
    );
  });

  it('rejects a cycle that ends before it starts', async () => {
    const prisma = buildSinglePrisma(null);

    await expect(
      serviceWith(prisma).createCycle({
        ...validCycle,
        endDate: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/must end after it starts/);
  });
});
