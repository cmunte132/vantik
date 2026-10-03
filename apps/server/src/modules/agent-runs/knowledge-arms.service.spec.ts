import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { AgentRunsController } from './agent-runs.controller';
import {
  type ArmRun,
  compareArms,
  KnowledgeArmsService,
} from './knowledge-arms.service';

/**
 * The runs handed knowledge beside the runs held out from it.
 *
 * What would mislead is a number measured over the wrong runs: a run still
 * going counted as a failure, a run that never reached a pass counted as
 * needing none, or a pull request still open counted as not merged.
 */

function run(overrides: Partial<ArmRun> = {}): ArmRun {
  return {
    knowledgeArm: 'TREATMENT',
    result: null,
    pullRequestOutcome: null,
    lastVerificationPassed: null,
    passes: 0,
    ...overrides,
  };
}

describe('comparing the arms', () => {
  it('[KG-3.6] reports each arm on the five measures, treatment first', () => {
    const [treatment, holdout] = compareArms([
      run({
        lastVerificationPassed: true,
        passes: 1,
        result: { costUsd: 0.4, prUrl: 'https://github.com/a/b/pull/1' },
        pullRequestOutcome: 'MERGED',
      }),
      run({
        lastVerificationPassed: false,
        passes: 3,
        result: { costUsd: 1.2, prUrl: 'https://github.com/a/b/pull/2' },
        pullRequestOutcome: 'CLOSED',
      }),
      run({
        lastVerificationPassed: true,
        passes: 2,
        result: { costUsd: 0.8, prUrl: 'https://github.com/a/b/pull/3' },
        pullRequestOutcome: 'MERGED',
      }),
      run({
        knowledgeArm: 'HOLDOUT',
        lastVerificationPassed: false,
        passes: 4,
        result: { costUsd: 2, prUrl: 'https://github.com/a/b/pull/4' },
        pullRequestOutcome: 'CLOSED',
      }),
    ]);

    expect(treatment).toEqual({
      arm: 'TREATMENT',
      runs: 3,
      verification: { count: 2, of: 3, rate: 2 / 3 },
      reviewPasses: { mean: 2, runs: 3 },
      costUsd: { mean: expect.closeTo(0.8), runs: 3 },
      merged: { count: 2, of: 3, rate: 2 / 3 },
      openPullRequests: 0,
    });
    expect(holdout).toEqual({
      arm: 'HOLDOUT',
      runs: 1,
      verification: { count: 0, of: 1, rate: 0 },
      reviewPasses: { mean: 4, runs: 1 },
      costUsd: { mean: 2, runs: 1 },
      merged: { count: 0, of: 1, rate: 0 },
      openPullRequests: 0,
    });
  });

  it('[KG-3.6] rates a pull request only once it is decided, and counts the open ones apart', () => {
    const [treatment] = compareArms([
      run({
        result: { prUrl: 'https://github.com/a/b/pull/1' },
        pullRequestOutcome: 'MERGED',
      }),
      run({ result: { prUrl: 'https://github.com/a/b/pull/2' } }),
      run({ result: { prUrl: 'https://github.com/a/b/pull/3' } }),
      // No pull request at all: neither open nor decided.
      run({ result: { prUrl: '' } }),
      run(),
    ]);

    expect(treatment.merged).toEqual({ count: 1, of: 1, rate: 1 });
    expect(treatment.openPullRequests).toBe(2);
  });

  it('[KG-3.6] leaves out of each measure the runs it says nothing about', () => {
    const [treatment] = compareArms([
      // Failed setting up: no checks ran, no pass, no cost reported.
      run({ lastVerificationPassed: null, passes: 0, result: { error: 'x' } }),
      run({ lastVerificationPassed: true, passes: 2, result: { costUsd: 1 } }),
      run({
        lastVerificationPassed: false,
        passes: 1,
        result: { costUsd: Number.NaN },
      }),
    ]);

    expect(treatment.runs).toBe(3);
    expect(treatment.verification).toEqual({ count: 1, of: 2, rate: 0.5 });
    // Counting the run that never reached a pass as nought would reward
    // failing early.
    expect(treatment.reviewPasses).toEqual({ mean: 1.5, runs: 2 });
    expect(treatment.costUsd).toEqual({ mean: 1, runs: 1 });
  });

  it('[KG-3.6] says there is nothing to rate rather than reporting nought', () => {
    const [treatment, holdout] = compareArms([run()]);

    expect(holdout).toEqual({
      arm: 'HOLDOUT',
      runs: 0,
      verification: { count: 0, of: 0, rate: null },
      reviewPasses: { mean: null, runs: 0 },
      costUsd: { mean: null, runs: 0 },
      merged: { count: 0, of: 0, rate: null },
      openPullRequests: 0,
    });
    expect(treatment.verification.rate).toBeNull();
    expect(treatment.merged.rate).toBeNull();
  });
});

describe('the runs the comparison reads', () => {
  function serviceWith(rows: unknown[], preferences: unknown = null) {
    const findMany = jest.fn(async () => rows);
    const findUnique = jest.fn(async () => ({ preferences }));
    const service = new KnowledgeArmsService({
      agentRun: { findMany },
      workspace: { findUnique },
    } as unknown as PrismaService);

    return { service, findMany, findUnique };
  }

  const ENV = process.env.KNOWLEDGE_HOLDOUT_RATE;

  afterEach(() => {
    if (ENV === undefined) {
      delete process.env.KNOWLEDGE_HOLDOUT_RATE;
    } else {
      process.env.KNOWLEDGE_HOLDOUT_RATE = ENV;
    }
  });

  it('[KG-3.6] reads the finished runs of the workspace that were given an arm', async () => {
    const { service, findMany } = serviceWith([]);
    const since = new Date('2026-09-01T00:00:00Z');

    await service.compare('ws-1', since);

    const [{ where }] = findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(where).toMatchObject({
      workspaceId: 'ws-1',
      deleted: null,
      knowledgeArm: { not: null },
      createdAt: { gte: since },
    });
    // A run still going has no outcome yet, and counting it would drag both
    // arms towards nought.
    const statuses = (where.status as { in: string[] }).in;
    expect(statuses).toEqual(
      expect.arrayContaining([
        'SUCCEEDED',
        'NEEDS_REVIEW',
        'FAILED',
        'CANCELED',
      ]),
    );
    expect(statuses).not.toContain('RUNNING');
    expect(statuses).not.toContain('QUEUED');
  });

  it('[KG-3.6] reads every run when no date is given, and says which rate is in force', async () => {
    process.env.KNOWLEDGE_HOLDOUT_RATE = '0.25';
    const { service, findMany } = serviceWith([
      {
        knowledgeArm: 'HOLDOUT',
        result: { costUsd: 0.5 },
        pullRequestOutcome: null,
        iterations: [{ verificationPassed: true }],
        _count: { iterations: 3 },
      },
      {
        knowledgeArm: 'TREATMENT',
        result: null,
        pullRequestOutcome: null,
        iterations: [],
        _count: { iterations: 0 },
      },
    ]);

    const comparison = await service.compare('ws-1');

    const [{ where }] = findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(where).not.toHaveProperty('createdAt');
    expect(comparison.holdoutRate).toBe(0.25);

    // The rate the workspace sets, when it sets one.
    const own = serviceWith([], { knowledge: { holdoutRate: 0.5 } });
    await expect(own.service.compare('ws-1')).resolves.toMatchObject({
      holdoutRate: 0.5,
    });
    expect(own.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { preferences: true },
    });
    expect(comparison.since).toBeNull();
    expect(comparison.arms[1]).toMatchObject({
      arm: 'HOLDOUT',
      runs: 1,
      verification: { count: 1, of: 1, rate: 1 },
      reviewPasses: { mean: 3, runs: 1 },
    });
    expect(comparison.arms[0].verification).toEqual({
      count: 0,
      of: 0,
      rate: null,
    });
  });
});

describe('the comparison over HTTP', () => {
  function controllerWith() {
    const compare = jest.fn(async () => ({ arms: [] as unknown[] }));
    const controller = new AgentRunsController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { compare } as unknown as KnowledgeArmsService,
      {} as never,
    );

    return { controller, compare };
  }

  it('[KG-3.6] is for the workspace’s people, not an agent token', async () => {
    const { controller, compare } = controllerWith();

    await expect(
      controller.knowledgeArmComparison('ws-1', RoleEnum.AGENT),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(compare).not.toHaveBeenCalled();

    await controller.knowledgeArmComparison('ws-1', RoleEnum.ADMIN);
    expect(compare).toHaveBeenCalledWith('ws-1', null);
  });

  it('[KG-3.6] reads from the date asked for, and refuses one that is not a date', async () => {
    const { controller, compare } = controllerWith();

    await controller.knowledgeArmComparison(
      'ws-1',
      RoleEnum.USER,
      '2026-09-01',
    );
    expect(compare).toHaveBeenCalledWith(
      'ws-1',
      new Date('2026-09-01T00:00:00.000Z'),
    );

    await expect(
      controller.knowledgeArmComparison('ws-1', RoleEnum.USER, 'last week'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(compare).toHaveBeenCalledTimes(1);
  });
});
