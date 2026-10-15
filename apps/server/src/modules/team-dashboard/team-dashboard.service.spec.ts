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

describe('TeamDashboardService.getStuckWithFindings', () => {
  const entered = new Date('2026-10-10T00:00:00Z');

  function build(findingEntered: Date) {
    const prisma = {
      workflow: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 's1', name: 'In Progress', category: 'STARTED' },
          ]),
      },
      teamDashboardSettings: {
        findUnique: jest.fn().mockResolvedValue({
          thresholdOverrides: { s1: 1 },
          learnedThresholds: {},
          learnedAt: new Date(),
          lastAnalysisAt: new Date('2026-10-14T00:00:00Z'),
          nextAnalysisAt: null,
        }),
      },
      issue: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'i1',
            number: 1,
            title: 'A',
            assigneeId: null,
            createdAt: entered,
            estimate: null,
            stateId: 's1',
            stateEnteredAt: entered,
            cycleId: null,
          },
        ]),
      },
      stuckIssueFinding: {
        findMany: jest.fn().mockResolvedValue([
          {
            issueId: 'i1',
            stateId: 's1',
            stateEnteredAt: findingEntered,
            cause: 'c',
            category: 'other',
            suggestions: ['s'],
            confidence: 0.5,
            updatedAt: new Date('2026-10-14T01:00:00Z'),
          },
        ]),
      },
    };
    return new TeamDashboardService(prisma as never);
  }

  it('shows a finding that matches the current state entry', async () => {
    const result = await build(entered).getStuckWithFindings('t1');
    expect(result.items[0].finding).toMatchObject({ cause: 'c' });
    expect(result.analysis.lastAnalysisAt).toBe('2026-10-14T00:00:00.000Z');
    expect(result.analysis.nextAnalysisAt).toBeNull();
  });

  it('hides a finding from an earlier entry into the state', async () => {
    const result = await build(
      new Date('2026-10-01T00:00:00Z'),
    ).getStuckWithFindings('t1');
    expect(result.items[0].finding).toBeNull();
  });
});
