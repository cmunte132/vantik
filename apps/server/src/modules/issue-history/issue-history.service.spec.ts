import IssuesHistoryService from './issue-history.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildPrisma(last: any) {
  return {
    issueHistory: {
      findFirst: jest.fn().mockResolvedValue(last),
      update: jest.fn().mockResolvedValue({ id: 'updated' }),
      create: jest.fn().mockResolvedValue({ id: 'created' }),
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const lastRow: Record<string, unknown> = {
  id: 'h1',
  userId: 'u1',
  addedLabelIds: [],
  removedLabelIds: [],
  fromStateId: null,
  toStateId: null,
};

describe('IssuesHistoryService.upsertIssueHistory', () => {
  it('merges a same-user edit that does not touch the state', async () => {
    const prisma = buildPrisma(lastRow);
    const service = new IssuesHistoryService(prisma as never);

    await service.upsertIssueHistory('u1', 'i1', {
      fromPriority: 1,
      toPriority: 2,
    } as never);

    expect(prisma.issueHistory.update).toHaveBeenCalledTimes(1);
    expect(prisma.issueHistory.create).not.toHaveBeenCalled();
  });

  it('gives a same-user state change its own row', async () => {
    const prisma = buildPrisma(lastRow);
    const service = new IssuesHistoryService(prisma as never);

    await service.upsertIssueHistory('u1', 'i1', {
      fromStateId: 'todo',
      toStateId: 'doing',
    } as never);

    expect(prisma.issueHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.issueHistory.update).not.toHaveBeenCalled();
  });

  it('does not merge an edit into a row that holds a state change', async () => {
    const prisma = buildPrisma({
      ...lastRow,
      fromStateId: 'todo',
      toStateId: 'doing',
    });
    const service = new IssuesHistoryService(prisma as never);

    await service.upsertIssueHistory('u1', 'i1', {
      fromPriority: 1,
      toPriority: 2,
    } as never);

    expect(prisma.issueHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.issueHistory.update).not.toHaveBeenCalled();
  });
});
