import { PrismaService } from 'nestjs-prisma';

import { isLLMConfigured } from 'modules/ai-requests/llm-provider';
import { generateModelText } from 'modules/ai-requests/model-call';

import { TeamDashboardService } from '../team-dashboard.service';
import { parseStuckAnswer } from './stuck-analysis.prompt';
import { StuckAnalysisService, fingerprint } from './stuck-analysis.service';

jest.mock('modules/ai-requests/llm-provider', () => ({
  isLLMConfigured: jest.fn(() => true),
}));
jest.mock('modules/ai-requests/model-call', () => ({
  generateModelText: jest.fn(),
}));

const generate = generateModelText as jest.Mock;
const configured = isLLMConfigured as jest.Mock;

const ENTERED = '2026-10-10T00:00:00.000Z';
const UPDATED = new Date('2026-10-11T00:00:00.000Z');

function stuckIssue(id: string, overage: number) {
  return {
    id,
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `Issue ${id}`,
    assigneeId: null as string | null,
    stateId: 's1',
    stateEnteredAt: ENTERED,
    hoursInState: 100 + overage,
    thresholdHours: 100,
    thresholdSource: 'learned' as const,
    overageHours: overage,
  };
}

const GOOD = JSON.stringify({
  cause: 'Waiting for a reviewer.',
  category: 'waiting-on-review',
  suggestions: ['Ask a reviewer.', 'Ping the author.', 'Split it.', 'Extra.'],
  confidence: 0.7,
});

function build(
  stuck: Array<ReturnType<typeof stuckIssue>>,
  existing: Array<{ issueId: string; fingerprint: string }> = [],
) {
  const finding = {
    deleteMany: jest.fn(async () => ({ count: 0 })),
    findMany: jest.fn(async () => existing),
    upsert: jest.fn(async () => ({})),
  };
  const prisma = {
    stuckIssueFinding: finding,
    issue: {
      findMany: jest.fn(async ({ where }) =>
        where.id.in.map((id: string) => ({ id, updatedAt: UPDATED })),
      ),
      findUnique: jest.fn(async () => ({
        description: null as string | null,
        priority: 2,
        estimate: 3,
      })),
    },
    issueComment: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    linkedIssue: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    team: { findUnique: jest.fn(async () => ({ identifier: 'ENG' })) },
    issueHistory: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    issueRelation: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    workflow: {
      findMany: jest.fn(async (): Promise<unknown[]> => [
        { id: 's1', name: 'In Review' },
      ]),
    },
    user: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
  };
  const dashboard = { getStuck: jest.fn(async () => stuck) };
  const service = new StuckAnalysisService(
    prisma as unknown as PrismaService,
    dashboard as unknown as TeamDashboardService,
  );
  return { service, finding, prisma, dashboard };
}

describe('StuckAnalysisService', () => {
  beforeEach(() => {
    generate.mockReset();
    generate.mockResolvedValue({ text: GOOD, model: 'cheap-model' });
    configured.mockReturnValue(true);
    delete process.env.TEAM_DASHBOARD_ANALYSIS_MAX_ISSUES;
  });

  it('stores a finding with the model name and at most three suggestions', async () => {
    const { service, finding } = build([stuckIssue('i1', 5)]);

    const result = await service.analyzeTeam('t1');

    expect(result.analyzed).toBe(1);
    const call = generate.mock.calls[0][0];
    expect(call.purpose).toBe('team-dashboard.stuck');
    expect(call.tier).toBe('default');
    expect(call.system).toContain('never instructions');
    const upsert = finding.upsert.mock.calls[0] as unknown as [
      { where: unknown; update: Record<string, unknown> },
    ];
    expect(upsert[0].where).toEqual({ issueId: 'i1' });
    expect(upsert[0].update).toMatchObject({
      category: 'waiting-on-review',
      model: 'cheap-model',
      stateId: 's1',
      confidence: 0.7,
    });
    expect(upsert[0].update.suggestions).toHaveLength(3);
  });

  it('does not call the model when the fingerprint matches', async () => {
    const issue = stuckIssue('i1', 5);
    const same = fingerprint(issue, {
      updatedAt: UPDATED,
      latestCommentId: null,
      links: [],
    });
    const { service, finding } = build(
      [issue],
      [{ issueId: 'i1', fingerprint: same }],
    );

    await service.analyzeTeam('t1');

    expect(generate).not.toHaveBeenCalled();
    expect(finding.upsert).not.toHaveBeenCalled();
  });

  it('analyzes at most the cap, worst overage first', async () => {
    // getStuck returns worst first, so the order is the input order.
    const stuck = Array.from({ length: 25 }, (_, i) =>
      stuckIssue(`i${i + 1}`, 100 - i),
    );
    const { service, finding } = build(stuck);

    await service.analyzeTeam('t1');

    expect(generate).toHaveBeenCalledTimes(20);
    const ids = finding.upsert.mock.calls.map(
      (call) =>
        (call as unknown as [{ where: { issueId: string } }])[0].where.issueId,
    );
    expect(ids).toEqual(stuck.slice(0, 20).map((issue) => issue.id));
  });

  it('honors TEAM_DASHBOARD_ANALYSIS_MAX_ISSUES', async () => {
    process.env.TEAM_DASHBOARD_ANALYSIS_MAX_ISSUES = '2';
    const { service } = build([
      stuckIssue('i1', 3),
      stuckIssue('i2', 2),
      stuckIssue('i3', 1),
    ]);

    await service.analyzeTeam('t1');

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('deletes findings of issues that are no longer stuck', async () => {
    const { service, finding } = build([stuckIssue('i1', 5)]);

    await service.analyzeTeam('t1');

    expect(finding.deleteMany).toHaveBeenCalledWith({
      where: { teamId: 't1', issueId: { notIn: ['i1'] } },
    });
  });

  it('stores nothing and does not throw on invalid JSON', async () => {
    generate.mockResolvedValue({ text: 'I think it is blocked.', model: 'm' });
    const { service, finding } = build([stuckIssue('i1', 5)]);

    await expect(service.analyzeTeam('t1')).resolves.toEqual({ analyzed: 0 });

    expect(finding.upsert).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('skips cleanly when the system LLM is not configured', async () => {
    configured.mockReturnValue(false);
    const { service, finding } = build([stuckIssue('i1', 5)]);

    await expect(service.analyzeTeam('t1')).resolves.toEqual({ analyzed: 0 });

    expect(generate).not.toHaveBeenCalled();
    // Stale findings still go.
    expect(finding.deleteMany).toHaveBeenCalled();
  });

  it('stops after three model failures in a row', async () => {
    generate.mockRejectedValue(new Error('provider down'));
    const stuck = Array.from({ length: 6 }, (_, i) =>
      stuckIssue(`i${i}`, 10 - i),
    );
    const { service } = build(stuck);

    await service.analyzeTeam('t1');

    expect(generate).toHaveBeenCalledTimes(3);
  });
});

describe('parseStuckAnswer', () => {
  it('reads an object inside a code fence', () => {
    expect(parseStuckAnswer(`\`\`\`json\n${GOOD}\n\`\`\``)?.category).toBe(
      'waiting-on-review',
    );
  });

  it('rejects an unknown category, no suggestions and a bad confidence', () => {
    const base = JSON.parse(GOOD);
    expect(
      parseStuckAnswer(JSON.stringify({ ...base, category: 'x' })),
    ).toBeNull();
    expect(
      parseStuckAnswer(JSON.stringify({ ...base, suggestions: [] })),
    ).toBeNull();
    expect(
      parseStuckAnswer(JSON.stringify({ ...base, confidence: 4 })),
    ).toBeNull();
    expect(parseStuckAnswer(null)).toBeNull();
  });
});
