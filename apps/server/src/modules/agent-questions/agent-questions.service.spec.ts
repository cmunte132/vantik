import { ConflictException, NotFoundException } from '@nestjs/common';

import { AgentQuestionsService } from './agent-questions.service';

const ITEMS = [
  { id: 'q1', prompt: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
];

function setup(row: Record<string, unknown> | null = null) {
  const store = row ? { ...row } : null;
  const prisma = {
    agentQuestion: {
      findFirst: jest.fn(async () => store),
      findMany: jest.fn(async () => (store ? [store] : [])),
      findUniqueOrThrow: jest.fn(async () => store),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'aq1',
        status: 'OPEN',
        ...data,
      })),
      updateMany: jest.fn(async () => {
        if (!store || store.status !== 'OPEN') {
          return { count: 0 };
        }
        store.status = 'ANSWERED';
        return { count: 1 };
      }),
    },
    agentRun: { findUnique: jest.fn(async () => ({ agentUserId: 'bot' })) },
    notification: { create: jest.fn(async () => ({})) },
    user: { findUnique: jest.fn(async () => ({ fullname: 'Ann' })) },
  };
  const service = new AgentQuestionsService(prisma as never);
  const hooks = {
    deliver: jest.fn(async () => true),
    event: jest.fn(async (): Promise<void> => undefined),
  };
  service.setHooks(hooks);
  return { service, prisma, hooks };
}

const open = (extra = {}) => ({
  id: 'aq1',
  workspaceId: 'w',
  agentRunId: 'r',
  externalId: 'ask-1',
  source: 'tool',
  status: 'OPEN',
  questions: ITEMS,
  expiresAt: new Date(Date.now() + 60_000),
  ...extra,
});

describe('AgentQuestionsService', () => {
  it('rejects an id that is not a plain token', async () => {
    const { service } = setup();
    await expect(
      service.create({
        workspaceId: 'w',
        issueId: 'i',
        agentRunId: 'r',
        externalId: '../x',
        source: 'tool',
        questions: ITEMS,
        assigneeId: 'u',
      }),
    ).rejects.toThrow(RangeError);
  });

  it('gives the same row for the same line read twice', async () => {
    const { service, prisma } = setup(open());
    const row = await service.create({
      workspaceId: 'w',
      issueId: 'i',
      agentRunId: 'r',
      externalId: 'ask-1',
      source: 'tool',
      questions: ITEMS,
      assigneeId: 'u',
    });
    expect(row.id).toBe('aq1');
    expect(prisma.agentQuestion.create).not.toHaveBeenCalled();
  });

  it('notifies the person who started the run, once', async () => {
    const { service, prisma } = setup();
    const input = {
      workspaceId: 'w',
      issueId: 'i',
      agentRunId: 'r',
      externalId: 'ask-2',
      source: 'tool' as const,
      questions: ITEMS,
      assigneeId: 'u',
    };
    await service.create(input);
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'AgentQuestionAsked',
        userId: 'u',
        issueId: 'i',
        createdById: 'bot',
        actionData: { agentQuestionId: 'aq1' },
      }),
    });
  });

  it('keeps the question when the notification fails', async () => {
    const { service, prisma } = setup();
    prisma.notification.create.mockRejectedValue(new Error('down') as never);
    const row = await service.create({
      workspaceId: 'w',
      issueId: 'i',
      agentRunId: 'r',
      externalId: 'ask-3',
      source: 'tool',
      questions: ITEMS,
      assigneeId: 'u',
    });
    expect(row.id).toBe('aq1');
  });

  it('stops a run that asks too many questions', async () => {
    const { service, prisma } = setup();
    prisma.agentQuestion.count.mockResolvedValue(5);
    await expect(
      service.create({
        workspaceId: 'w',
        issueId: 'i',
        agentRunId: 'r',
        externalId: 'ask-9',
        source: 'tool',
        questions: ITEMS,
        assigneeId: 'u',
      }),
    ).rejects.toThrow(/may ask/);
  });

  it('answers once and delivers', async () => {
    const { service, hooks } = setup(open());
    await service.answer(
      'aq1',
      { workspaceId: 'w', userId: 'u' },
      { answers: [{ id: 'q1', selected: ['A'] }] },
    );
    expect(hooks.deliver).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer that names no option', async () => {
    const { service } = setup(open());
    await expect(
      service.answer(
        'aq1',
        { workspaceId: 'w', userId: 'u' },
        { answers: [{ id: 'q1', selected: ['Z'] }] },
      ),
    ).rejects.toThrow(RangeError);
  });

  it('refuses a second answer', async () => {
    const { service } = setup(open({ status: 'ANSWERED' }));
    await expect(
      service.answer(
        'aq1',
        { workspaceId: 'w', userId: 'u' },
        { answers: [{ id: 'q1', selected: ['A'] }] },
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('is not found in another workspace', async () => {
    const { service, prisma } = setup();
    prisma.agentQuestion.findFirst.mockResolvedValue(null as never);
    await expect(
      service.answer('aq1', { workspaceId: 'x', userId: 'u' }, { answers: [] }),
    ).rejects.toThrow(NotFoundException);
  });
});
