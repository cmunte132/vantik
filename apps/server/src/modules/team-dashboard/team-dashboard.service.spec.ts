import { BadRequestException } from '@nestjs/common';
import { UpdateThresholdOverridesDto } from '@vantikhq/types';
import { validate } from 'class-validator';

import { TeamDashboardService } from './team-dashboard.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildPrisma(existingOverrides: Record<string, number> = {}) {
  return {
    workflow: {
      findMany: jest.fn().mockResolvedValue([
        { id: 's1', name: 'In Progress', category: 'STARTED' },
        { id: 's2', name: 'Done', category: 'COMPLETED' },
      ]),
    },
    teamDashboardSettings: {
      findUnique: jest.fn().mockResolvedValue({
        thresholdOverrides: existingOverrides,
        learnedThresholds: {},
        learnedAt: new Date(),
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },
  } as any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('TeamDashboardService.setOverrides', () => {
  it('rejects a state that is not in the team', async () => {
    const service = new TeamDashboardService(buildPrisma());
    await expect(
      service.setOverrides('t1', { other: 10 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects hours that are not above zero', async () => {
    const service = new TeamDashboardService(buildPrisma());
    await expect(service.setOverrides('t1', { s1: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.setOverrides('t1', { s1: -5 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('stores a number and clears an override with null', async () => {
    const prisma = buildPrisma({ s1: 40, s2: 10 });
    const service = new TeamDashboardService(prisma);

    await service.setOverrides('t1', { s1: null });

    const call = prisma.teamDashboardSettings.upsert.mock.calls[0][0];
    expect(call.update.thresholdOverrides).toEqual({ s2: 10 });

    await service.setOverrides('t1', { s1: 72 });
    const second = prisma.teamDashboardSettings.upsert.mock.calls[1][0];
    expect(second.update.thresholdOverrides).toEqual({ s1: 72, s2: 10 });
  });
});

describe('UpdateThresholdOverridesDto', () => {
  it('needs an object for overrides', async () => {
    const dto = new UpdateThresholdOverridesDto();
    (dto as unknown as Record<string, unknown>).overrides = 'nope';
    expect((await validate(dto)).length).toBeGreaterThan(0);

    dto.overrides = { s1: 5, s2: null };
    expect(await validate(dto)).toHaveLength(0);
    expect(Object.keys(dto)).toEqual(['overrides']);
  });
});
