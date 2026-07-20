import {
  GetIssuesByFilterDTO,
  IssueViewEnum,
  PaginatedIssues,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssuesService from './issues.service';

const tiptap = (text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const issueRows: any[] = [
  {
    id: 'issue-1',
    number: 42,
    title: 'Connections exhausted under load',
    description: tiptap('Nightly job saturates the pool'),
    stateId: 'state-done',
    assigneeId: 'user-1',
    priority: 2,
    labelIds: ['label-bug'],
    projectId: 'project-1',
    updatedAt: new Date('2026-01-02T10:00:00Z'),
    team: { id: 'team-1', identifier: 'ENG' },
  },
];

function buildService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    issue: {
      findMany: jest.fn().mockResolvedValue(issueRows),
      count: jest.fn().mockResolvedValue(123),
    },
    workflow: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'state-done', category: 'COMPLETED' }]),
    },
    ...overrides,
  } as unknown as PrismaService;

  const service = new IssuesService(prisma, null, null, null, null, null, null);

  return { service, prisma };
}

const baseFilter = {
  filters: {},
  workspaceId: 'workspace-1',
} as GetIssuesByFilterDTO;

describe('IssuesService.getIssuesByFilter', () => {
  it('keeps returning a bare array when no pagination params are sent', async () => {
    const { service, prisma } = buildService();

    const result = await service.getIssuesByFilter(baseFilter);

    expect(Array.isArray(result)).toBe(true);
    expect(
      (prisma.issue.findMany as jest.Mock).mock.calls[0][0].take,
    ).toBeUndefined();
  });

  it('returns a paginated envelope once any new param is sent', async () => {
    const { service, prisma } = buildService();

    const result = (await service.getIssuesByFilter({
      ...baseFilter,
      page: 2,
      perPage: 25,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as PaginatedIssues<any>;

    expect(result.page).toBe(2);
    expect(result.perPage).toBe(25);
    expect(result.total).toBe(123);
    const query = (prisma.issue.findMany as jest.Mock).mock.calls[0][0];
    expect(query.skip).toBe(25);
    expect(query.take).toBe(25);
    expect(query.orderBy).toEqual({ updatedAt: 'desc' });
  });

  // Over-large values are rejected with a 400 by the DTO's @Max before they
  // ever reach the service; this clamp only guards non-HTTP callers.
  it('clamps perPage for callers that bypass DTO validation', async () => {
    const { service } = buildService();

    const result = (await service.getIssuesByFilter({
      ...baseFilter,
      perPage: 5000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as PaginatedIssues<any>;

    expect(result.perPage).toBe(200);
  });

  it('defaults to the lean list view with no description', async () => {
    const { service } = buildService();

    const result = (await service.getIssuesByFilter({
      ...baseFilter,
      page: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as PaginatedIssues<any>;

    expect(result.issues[0]).toEqual({
      id: 'issue-1',
      key: 'ENG-42',
      title: 'Connections exhausted under load',
      stateId: 'state-done',
      stateCategory: 'COMPLETED',
      assigneeId: 'user-1',
      priority: 2,
      labelIds: ['label-bug'],
      projectId: 'project-1',
      updatedAt: new Date('2026-01-02T10:00:00Z'),
    });
  });

  it('adds the markdown twin in the full view', async () => {
    const { service } = buildService();

    const result = (await service.getIssuesByFilter({
      ...baseFilter,
      page: 1,
      view: IssueViewEnum.FULL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as PaginatedIssues<any>;

    expect(result.issues[0].descriptionMarkdown).toContain(
      'Nightly job saturates the pool',
    );
  });
});
