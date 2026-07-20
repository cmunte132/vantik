import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import IssueContextService from './issue-context.service';

const team = { id: 'team-1', identifier: 'ENG', name: 'Engineering' };

const issueRows = [
  {
    id: 'issue-1',
    number: 42,
    title: 'Connections exhausted under load',
    stateId: 'state-started',
    teamId: team.id,
    team,
  },
  {
    id: 'issue-2',
    number: 12,
    title: 'Blocked by infra rollout',
    stateId: 'state-done',
    teamId: team.id,
    team,
  },
  {
    id: 'issue-3',
    number: 43,
    title: 'Add pool metrics',
    stateId: 'state-done',
    teamId: team.id,
    team,
  },
  {
    id: 'issue-4',
    number: 40,
    title: 'Database reliability',
    stateId: 'state-started',
    teamId: team.id,
    team,
  },
  {
    id: 'issue-5',
    number: 50,
    title: 'Blocks this one',
    stateId: 'state-started',
    teamId: team.id,
    team,
  },
];

const tiptap = (text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const comments: any[] = [
  {
    id: 'comment-1',
    issueId: 'issue-1',
    userId: 'user-1',
    parentId: null,
    body: tiptap('Looks like the pg pool is too small'),
    createdAt: new Date('2026-01-01T10:00:00Z'),
    updatedAt: new Date('2026-01-01T10:00:00Z'),
    deleted: null,
  },
  {
    id: 'comment-2',
    issueId: 'issue-1',
    userId: 'user-2',
    parentId: 'comment-1',
    body: tiptap('Agreed, bumping it'),
    createdAt: new Date('2026-01-01T11:00:00Z'),
    updatedAt: new Date('2026-01-01T11:00:00Z'),
    deleted: null,
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const historyRows: any[] = [
  {
    id: 'history-1',
    issueId: 'issue-1',
    userId: 'user-1',
    createdAt: new Date('2026-01-01T09:00:00Z'),
    deleted: null,
    fromStateId: 'state-todo',
    toStateId: 'state-started',
    fromAssigneeId: null,
    toAssigneeId: 'user-1',
    fromPriority: null,
    toPriority: 2,
    fromEstimate: null,
    toEstimate: null,
    fromTeamId: null,
    toTeamId: null,
    fromProjectId: null,
    toProjectId: null,
    fromCycleId: null,
    toCycleId: null,
    fromParentId: null,
    toParentId: null,
    addedLabelIds: ['label-bug'],
    removedLabelIds: ['label-stale'],
  },
  {
    // Nothing readable changed — must be dropped entirely.
    id: 'history-2',
    issueId: 'issue-1',
    userId: 'user-1',
    createdAt: new Date('2026-01-01T09:30:00Z'),
    deleted: null,
    fromStateId: null,
    toStateId: null,
    fromAssigneeId: null,
    toAssigneeId: null,
    fromPriority: null,
    toPriority: null,
    fromEstimate: null,
    toEstimate: null,
    fromTeamId: null,
    toTeamId: null,
    fromProjectId: null,
    toProjectId: null,
    fromCycleId: null,
    toCycleId: null,
    fromParentId: null,
    toParentId: null,
    addedLabelIds: [],
    removedLabelIds: [],
  },
];

const workflows = [
  { id: 'state-todo', name: 'Todo', category: 'UNSTARTED' },
  { id: 'state-started', name: 'In Progress', category: 'STARTED' },
  { id: 'state-done', name: 'Done', category: 'COMPLETED' },
];

const labels = [
  { id: 'label-bug', name: 'bug' },
  { id: 'label-stale', name: 'stale' },
];

const users = [
  { id: 'user-1', fullname: 'Jane Doe' },
  { id: 'user-2', fullname: 'Sam Roe' },
];

interface FindManyArgs {
  where?: { id?: { in?: string[] } };
}

function byIdFilter<T extends { id: string }>(
  rows: T[],
  where: FindManyArgs['where'],
): T[] {
  const ids = where?.id?.in;
  return ids ? rows.filter((row) => ids.includes(row.id)) : rows;
}

function buildPrisma(overrides: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mainIssue: any = {
    ...issueRows[0],
    description: tiptap('Pool exhausted during the nightly job'),
    priority: 2,
    estimate: null,
    dueDate: null,
    labelIds: ['label-bug'],
    assigneeId: 'user-1',
    createdAt: new Date('2026-01-01T08:00:00Z'),
    updatedAt: new Date('2026-01-01T12:00:00Z'),
    project: null,
    cycle: null,
    parent: issueRows[3],
    subIssue: [issueRows[2]],
    comments,
    history: historyRows,
    linkedIssue: [
      {
        id: 'link-1',
        url: 'https://github.com/acme/repo/pull/12',
        sourceData: { title: 'PR #12' },
      },
    ],
    issueRelations: [
      { id: 'rel-1', relatedIssueId: 'issue-2', type: 'BLOCKS' },
    ],
  };

  return {
    issue: {
      findFirst: jest.fn().mockResolvedValue(mainIssue),
      findMany: jest.fn(({ where }: FindManyArgs) =>
        Promise.resolve(byIdFilter(issueRows, where)),
      ),
    },
    issueRelation: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'rel-2', issueId: 'issue-5', type: 'BLOCKS' },
        ]),
    },
    issueComment: {
      findMany: jest.fn().mockResolvedValue(comments),
    },
    issueHistory: {
      findMany: jest.fn().mockResolvedValue(historyRows),
    },
    workflow: {
      findMany: jest.fn(({ where }: FindManyArgs) =>
        Promise.resolve(byIdFilter(workflows, where)),
      ),
    },
    label: {
      findMany: jest.fn(({ where }: FindManyArgs) =>
        Promise.resolve(byIdFilter(labels, where)),
      ),
    },
    user: {
      findMany: jest.fn(({ where }: FindManyArgs) =>
        Promise.resolve(byIdFilter(users, where)),
      ),
    },
    team: { findMany: jest.fn().mockResolvedValue([]) },
    project: { findMany: jest.fn().mockResolvedValue([]) },
    cycle: { findMany: jest.fn().mockResolvedValue([]) },
    ...overrides,
  } as unknown as PrismaService;
}

describe('IssueContextService', () => {
  describe('getIssueContext', () => {
    it('resolves every id to a human readable name', async () => {
      const service = new IssueContextService(buildPrisma());

      const context = await service.getIssueContext('issue-1');

      expect(context.key).toBe('ENG-42');
      expect(context.state).toEqual({
        id: 'state-started',
        name: 'In Progress',
        category: 'STARTED',
      });
      expect(context.assignee).toEqual({ id: 'user-1', fullname: 'Jane Doe' });
      expect(context.team).toEqual(team);
      expect(context.labels).toEqual([{ id: 'label-bug', name: 'bug' }]);
      expect(context.parent).toMatchObject({ key: 'ENG-40' });
      expect(context.subIssues).toEqual([
        {
          id: 'issue-3',
          key: 'ENG-43',
          title: 'Add pool metrics',
          stateCategory: 'COMPLETED',
        },
      ]);
      expect(context.linkedIssues).toEqual([
        {
          id: 'link-1',
          url: 'https://github.com/acme/repo/pull/12',
          title: 'PR #12',
        },
      ]);
    });

    it('converts rich text to markdown and never leaks tiptap json', async () => {
      const service = new IssueContextService(buildPrisma());

      const context = await service.getIssueContext('issue-1');

      expect(context.descriptionMarkdown).toContain(
        'Pool exhausted during the nightly job',
      );
      expect(JSON.stringify(context)).not.toContain('"type":"doc"');
    });

    it('normalises relations to the requested issue perspective', async () => {
      const service = new IssueContextService(buildPrisma());

      const context = await service.getIssueContext('issue-1');

      expect(context.relations).toEqual([
        {
          type: 'BLOCKS',
          issue: expect.objectContaining({ key: 'ENG-12' }),
        },
        // Stored as issue-5 BLOCKS issue-1, so from issue-1 it reads BLOCKED.
        {
          type: 'BLOCKED',
          issue: expect.objectContaining({ key: 'ENG-50' }),
        },
      ]);
    });

    it('nests replies one level under their parent comment', async () => {
      const service = new IssueContextService(buildPrisma());

      const context = await service.getIssueContext('issue-1');

      expect(context.comments).toHaveLength(1);
      expect(context.comments[0].author).toEqual({
        id: 'user-1',
        fullname: 'Jane Doe',
      });
      expect(context.comments[0].bodyMarkdown).toContain('pg pool');
      expect(context.comments[0].replies).toHaveLength(1);
      expect(context.comments[0].replies[0].bodyMarkdown).toContain(
        'bumping it',
      );
    });

    it('condenses history and drops rows where nothing changed', async () => {
      const service = new IssueContextService(buildPrisma());

      const context = await service.getIssueContext('issue-1');

      expect(context.history).toEqual([
        expect.objectContaining({
          actor: 'Jane Doe',
          change: 'state',
          from: 'Todo',
          to: 'In Progress',
        }),
        expect.objectContaining({
          change: 'assignee',
          from: null,
          to: 'Jane Doe',
        }),
        expect.objectContaining({
          change: 'priority',
          from: null,
          to: 'High',
        }),
        expect.objectContaining({ change: 'label', from: null, to: 'bug' }),
        expect.objectContaining({ change: 'label', from: 'stale', to: null }),
      ]);
    });

    it('throws when the issue is missing or deleted', async () => {
      const prisma = buildPrisma({
        issue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
      });

      await expect(
        new IssueContextService(prisma).getIssueContext('nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getIssueComments', () => {
    it('returns top level comments with replies nested', async () => {
      const service = new IssueContextService(buildPrisma());

      const result = await service.getIssueComments('issue-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('comment-1');
      expect(result[0].replies).toHaveLength(1);
    });
  });

  describe('getIssueHistory', () => {
    it('returns the same condensed entries standalone', async () => {
      const service = new IssueContextService(buildPrisma());

      const history = await service.getIssueHistory('issue-1');

      expect(history.map((entry) => entry.change)).toEqual([
        'state',
        'assignee',
        'priority',
        'label',
        'label',
      ]);
    });
  });
});
