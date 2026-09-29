import { PrismaService } from 'nestjs-prisma';

import KnowledgeGardenerService, { brief } from './knowledge-gardener.service';

const decided = (decision: string) => [{ decision }];

function withFlowRows(written: unknown[], retired: unknown[]) {
  const findMany = jest
    .fn()
    .mockResolvedValueOnce(written)
    .mockResolvedValueOnce(retired);

  return new KnowledgeGardenerService(
    {
      pageEntry: { findMany },
      pageEntryUse: { count: jest.fn(async () => 7) },
      pageEntrySignal: {
        findMany: jest.fn(async () => [
          { agentRunId: 'run-1', kind: 'HELPFUL' },
          { agentRunId: 'run-1', kind: 'HELPFUL' },
          { agentRunId: 'run-2', kind: 'HARMFUL' },
        ]),
      },
    } as unknown as PrismaService,
    {} as never,
    {} as never,
  );
}

describe('the life of a fact', () => {
  it('puts each fact written in the window in one place', async () => {
    const service = withFlowRows(
      [
        { id: 'a', status: 'PROPOSED', verifiedAt: null, triageDecisions: [] },
        {
          id: 'b',
          status: 'ARCHIVED',
          verifiedAt: null,
          triageDecisions: decided('REJECT'),
        },
        {
          id: 'c',
          status: 'ARCHIVED',
          verifiedAt: null,
          triageDecisions: decided('CORROBORATE'),
        },
        {
          id: 'd',
          status: 'STANDING',
          verifiedAt: null,
          triageDecisions: decided('AUTO_ACCEPT'),
        },
        {
          id: 'e',
          status: 'STANDING',
          verifiedAt: new Date(),
          triageDecisions: decided('AUTO_ACCEPT'),
        },
        {
          id: 'f',
          status: 'CONSOLIDATED',
          verifiedAt: null,
          triageDecisions: [],
        },
      ],
      [],
    );

    const flow = await service.flow('ws', new Date(0));

    expect(flow).toMatchObject({
      written: 6,
      waiting: 1,
      refused: 1,
      folded: 1,
      settledByAgents: 1,
      // A person confirmed e, and a person accepted f.
      decidedByPeople: 2,
      inUse: 3,
      givenTimes: 7,
      runsWell: 1,
      runsWrong: 1,
    });
  });

  it('says why each retired fact left use, and leaves out the refused', async () => {
    const service = withFlowRows(
      [],
      [
        {
          id: 'r1',
          status: 'SUPERSEDED',
          triageDecisions: [],
          maintenance: [],
        },
        {
          id: 'r2',
          status: 'DISPUTED',
          triageDecisions: [],
          maintenance: [{ reason: 'CITATION_CONTRADICTED' }],
        },
        {
          id: 'r3',
          status: 'ARCHIVED',
          triageDecisions: [],
          maintenance: [{ reason: 'UNUSED' }],
        },
        { id: 'r4', status: 'ARCHIVED', triageDecisions: [], maintenance: [] },
        {
          id: 'r5',
          status: 'ARCHIVED',
          triageDecisions: decided('REJECT'),
          maintenance: [],
        },
      ],
    );

    expect(await service.flow('ws', new Date(0))).toMatchObject({
      retired: 4,
      retiredReplaced: 1,
      retiredContradicted: 1,
      retiredUnused: 1,
      retiredOther: 1,
    });
  });
});

describe('the title of a fact', () => {
  it('keeps the first sentence, cut at a word when it is long', () => {
    expect(brief('Redis holds only cache. Postgres holds the rest.')).toBe(
      'Redis holds only cache',
    );
    expect(brief('word '.repeat(40), 20)).toBe('word word word word…');
  });
});
