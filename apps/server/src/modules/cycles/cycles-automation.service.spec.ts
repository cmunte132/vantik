import {
  CyclesModeEnum,
  CycleStatusEnum,
  UnfinishedDestinationEnum,
} from '@vantikhq/types';

import { CyclesAutomationService } from './cycles-automation.service';

/**
 * The rules the automatic cadence lives or dies by: manual teams are never
 * touched, a stopped team is not quietly restarted, and a running team never
 * runs out of cycles. Each of those failing looks like the feature working
 * until somebody checks a month later.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const AUTO_RUNNING = {
  cyclesEnabled: true,
  cyclesMode: CyclesModeEnum.AUTO,
  cyclesAutoRunning: true,
  cyclesFrequency: 2,
  upcomingCycles: 2,
};

function buildPrisma({
  teams = [{ id: 'team-1', name: 'Engineering', preferences: AUTO_RUNNING }],
  upcomingCount = 2,
  endedCycles = [],
  lastCycle = {
    number: 5,
    endDate: new Date('2026-08-01T00:00:00.000Z'),
  },
}: any = {}) {
  // Stateful, because the pass replenishes, closes, then replenishes again:
  // a mock that answered 0 to every count would have the second top-up repeat
  // the first one's work, and the test would be asserting on an artefact.
  let created = 0;

  return {
    team: {
      findMany: jest.fn().mockResolvedValue(teams),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ preferences: teams[0]?.preferences ?? {} }),
      update: jest.fn().mockImplementation((args: any) => args),
    },
    cycle: {
      findMany: jest.fn().mockResolvedValue(endedCycles),
      findFirst: jest.fn().mockResolvedValue(lastCycle),
      count: jest.fn().mockImplementation(() => upcomingCount + created),
      create: jest.fn().mockImplementation((args: any) => {
        created += 1;
        return args.data;
      }),
      updateMany: jest.fn().mockImplementation((args: any) => args),
    },
    issue: {
      updateMany: jest.fn().mockImplementation((args: any) => args),
    },
    $transaction: jest.fn().mockImplementation((calls: any[]) => calls),
  };
}

function buildCycles() {
  return {
    createCycles: jest.fn().mockResolvedValue([]),
    completeCycle: jest.fn().mockResolvedValue({}),
  };
}

function serviceWith(prisma: any, cycles: any = buildCycles()) {
  return {
    service: new CyclesAutomationService(prisma, cycles as any),
    cycles,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('CyclesAutomationService.runMaintenance', () => {
  it('leaves manual teams entirely alone', async () => {
    const prisma = buildPrisma({
      teams: [
        {
          id: 'team-1',
          name: 'Engineering',
          preferences: {
            cyclesEnabled: true,
            cyclesMode: CyclesModeEnum.MANUAL,
            cyclesAutoRunning: true,
          },
        },
      ],
      upcomingCount: 0,
      endedCycles: [{ id: 'cycle-1' }],
    });
    const { service, cycles } = serviceWith(prisma);

    const result = await service.runMaintenance();

    expect(result.teamsVisited).toBe(0);
    expect(cycles.completeCycle).not.toHaveBeenCalled();
    expect(prisma.cycle.create).not.toHaveBeenCalled();
  });

  it('does not re-seed a team whose cadence was stopped', async () => {
    const prisma = buildPrisma({
      teams: [
        {
          id: 'team-1',
          name: 'Engineering',
          preferences: { ...AUTO_RUNNING, cyclesAutoRunning: false },
        },
      ],
      upcomingCount: 0,
    });
    const { service } = serviceWith(prisma);

    await service.runMaintenance();

    expect(prisma.cycle.create).not.toHaveBeenCalled();
  });

  it('skips a team that has cycles disabled outright', async () => {
    const prisma = buildPrisma({
      teams: [
        {
          id: 'team-1',
          name: 'Engineering',
          preferences: { ...AUTO_RUNNING, cyclesEnabled: false },
        },
      ],
      upcomingCount: 0,
    });
    const { service } = serviceWith(prisma);

    await service.runMaintenance();

    expect(prisma.cycle.create).not.toHaveBeenCalled();
  });

  it('tops a running team back up to its configured number ahead', async () => {
    const prisma = buildPrisma({ upcomingCount: 0 });
    const { service } = serviceWith(prisma);

    await service.runMaintenance();

    const numbers = prisma.cycle.create.mock.calls.map(
      (call) => call[0].data.number,
    );
    expect(numbers).toEqual([6, 7]);
  });

  it('continues the dates from where the last cycle ends', async () => {
    const prisma = buildPrisma({ upcomingCount: 0 });
    const { service } = serviceWith(prisma);

    await service.runMaintenance();

    const [first, second] = prisma.cycle.create.mock.calls.map(
      (call) => call[0].data,
    );

    expect(first.startDate).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    // Two weeks, from the cadence preference.
    expect(first.endDate).toEqual(new Date('2026-08-15T00:00:00.000Z'));
    expect(second.startDate).toEqual(first.endDate);
  });

  it('creates nothing when the team already has enough ahead', async () => {
    const prisma = buildPrisma({ upcomingCount: 2 });
    const { service } = serviceWith(prisma);

    await service.runMaintenance();

    expect(prisma.cycle.create).not.toHaveBeenCalled();
  });

  it('creates them upcoming, never current', async () => {
    const prisma = buildPrisma({ upcomingCount: 0 });
    const { service } = serviceWith(prisma);

    await service.runMaintenance();

    prisma.cycle.create.mock.calls.forEach((call) => {
      expect(call[0].data.status).toBe(CycleStatusEnum.UPCOMING);
    });
  });

  it('completes an ended cycle, rolling work to the next by default', async () => {
    const prisma = buildPrisma({ endedCycles: [{ id: 'cycle-5' }] });
    const { service, cycles } = serviceWith(prisma);

    const result = await service.runMaintenance();

    expect(cycles.completeCycle).toHaveBeenCalledWith('cycle-5', {
      unfinishedDestination: UnfinishedDestinationEnum.NEXT_CYCLE,
    });
    expect(result.cyclesClosed).toBe(1);
  });

  it('honours a team that would rather send the work back to the backlog', async () => {
    const prisma = buildPrisma({
      teams: [
        {
          id: 'team-1',
          name: 'Engineering',
          preferences: {
            ...AUTO_RUNNING,
            autoRolloverDestination: UnfinishedDestinationEnum.BACKLOG,
          },
        },
      ],
      endedCycles: [{ id: 'cycle-5' }],
    });
    const { service, cycles } = serviceWith(prisma);

    await service.runMaintenance();

    expect(cycles.completeCycle).toHaveBeenCalledWith('cycle-5', {
      unfinishedDestination: UnfinishedDestinationEnum.BACKLOG,
    });
  });

  it('tops the team up between closes, not only before the batch', async () => {
    // Each completion promotes an upcoming cycle and so consumes one. A team
    // coming back from an outage has more ended cycles than it keeps ahead, so
    // topping up once at the front left the last completion with no successor
    // to move work into — it threw, and took the rest of that team's pass with
    // it, including the closing top-up.
    const prisma = buildPrisma({
      upcomingCount: 2,
      endedCycles: [{ id: 'cycle-5' }, { id: 'cycle-6' }, { id: 'cycle-7' }],
    });

    // A count that falls as completions eat the upcoming cycles, which is what
    // makes the difference between topping up once and topping up per close.
    let ahead = 2;
    prisma.cycle.count = jest.fn().mockImplementation(async () => ahead);
    prisma.cycle.create = jest.fn().mockImplementation((args: any) => {
      ahead += 1;
      return args.data;
    });

    const cycles = buildCycles();
    cycles.completeCycle = jest.fn().mockImplementation(async () => {
      ahead -= 1;
      return {};
    });

    const { service } = serviceWith(prisma, cycles);
    const result = await service.runMaintenance();

    expect(cycles.completeCycle).toHaveBeenCalledTimes(3);
    expect(result.cyclesClosed).toBe(3);
    // One replaced before each of the last two closes, one after the batch.
    expect(result.cyclesCreated).toBe(3);
    expect(ahead).toBe(2);
  });

  it('keeps going after one team fails', async () => {
    const prisma = buildPrisma({
      teams: [
        { id: 'team-1', name: 'Broken', preferences: AUTO_RUNNING },
        { id: 'team-2', name: 'Fine', preferences: AUTO_RUNNING },
      ],
      endedCycles: [{ id: 'cycle-5' }],
    });
    const cycles = buildCycles();
    cycles.completeCycle
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValue({});
    const { service } = serviceWith(prisma, cycles);

    const result = await service.runMaintenance();

    expect(result.teamsVisited).toBe(2);
    expect(cycles.completeCycle).toHaveBeenCalledTimes(2);
  });
});

describe('CyclesAutomationService.startAutoCycles', () => {
  it('refuses to seed a second batch when already running', async () => {
    const prisma = buildPrisma();
    const { service, cycles } = serviceWith(prisma);

    await expect(service.startAutoCycles('team-1')).rejects.toThrow(
      /already running/,
    );

    expect(cycles.createCycles).not.toHaveBeenCalled();
  });

  it('seeds and marks the cadence running', async () => {
    const prisma = buildPrisma({
      teams: [
        {
          id: 'team-1',
          name: 'Engineering',
          preferences: { ...AUTO_RUNNING, cyclesAutoRunning: false },
        },
      ],
    });
    const { service, cycles } = serviceWith(prisma);

    await service.startAutoCycles('team-1');

    expect(cycles.createCycles).toHaveBeenCalledWith('team-1');
    expect(
      prisma.team.update.mock.calls[0][0].data.preferences.cyclesAutoRunning,
    ).toBe(true);
  });
});

describe('CyclesAutomationService.stopAutoCycles', () => {
  it('removes the upcoming cycles and detaches their issues', async () => {
    const prisma = buildPrisma({});
    prisma.cycle.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'cycle-6' }, { id: 'cycle-7' }]);
    const { service } = serviceWith(prisma);

    const result = await service.stopAutoCycles('team-1');

    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { cycleId: { in: ['cycle-6', 'cycle-7'] }, deleted: null },
      data: { cycleId: null },
    });
    expect(
      prisma.cycle.updateMany.mock.calls[0][0].data.deleted,
    ).toBeInstanceOf(Date);
    expect(result.removed).toBe(2);
  });

  it('leaves the running cycle to finish', async () => {
    const prisma = buildPrisma({});
    prisma.cycle.findMany = jest.fn().mockResolvedValue([]);
    const { service } = serviceWith(prisma);

    await service.stopAutoCycles('team-1');

    expect(prisma.cycle.findMany.mock.calls[0][0].where.status).toBe(
      CycleStatusEnum.UPCOMING,
    );
  });

  it('marks the cadence stopped so the schedule stops topping up', async () => {
    const prisma = buildPrisma({});
    prisma.cycle.findMany = jest.fn().mockResolvedValue([]);
    const { service } = serviceWith(prisma);

    await service.stopAutoCycles('team-1');

    expect(
      prisma.team.update.mock.calls[0][0].data.preferences.cyclesAutoRunning,
    ).toBe(false);
  });

  it('refuses a manual team, whose upcoming cycles are its own plan', async () => {
    // This soft-deletes every upcoming cycle and detaches its issues. On a team
    // that plans its own cycles that is somebody's roadmap, and the only thing
    // that had been keeping this route off it was the button not being drawn.
    const prisma = buildPrisma({
      teams: [
        {
          id: 'team-1',
          name: 'Engineering',
          preferences: { cyclesEnabled: true, cyclesMode: CyclesModeEnum.MANUAL },
        },
      ],
    });
    prisma.cycle.findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'cycle-6' }, { id: 'cycle-7' }]);
    const { service } = serviceWith(prisma);

    await expect(service.stopAutoCycles('team-1')).rejects.toThrow(
      /runs its cycles manually/,
    );
    expect(prisma.cycle.updateMany).not.toHaveBeenCalled();
    expect(prisma.issue.updateMany).not.toHaveBeenCalled();
  });
});
