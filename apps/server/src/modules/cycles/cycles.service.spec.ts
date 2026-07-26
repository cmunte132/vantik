import { CycleStatusEnum } from '@vantikhq/types';

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
