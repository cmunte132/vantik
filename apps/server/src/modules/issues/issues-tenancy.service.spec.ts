/**
 * Tenancy scoping for issue reads.
 *
 * Regression cover for a cross-workspace leak: `GET /v1/issues` built its
 * `where` from an optional `issueIds` param, so omitting it produced an
 * unfiltered `findMany` over every issue in the deployment, and
 * `POST /v1/issues/filter` scoped on a `workspaceId` taken from the request
 * body, which let any authenticated caller read another workspace's issues.
 *
 * The invariant these tests protect: the workspace comes from the session, and
 * a query is never issued without one.
 */
import { GetIssuesByFilterDTO } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssuesService from './issues.service';
import { getFilterWhere } from './issues.utils';

const SESSION_WORKSPACE = 'workspace-mine';
const OTHER_WORKSPACE = 'workspace-theirs';

function buildService() {
  const prisma = {
    issue: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    workflow: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;

  const service = new IssuesService(prisma, null, null, null, null, null, null);

  return { service, prisma };
}

const whereOf = (prisma: PrismaService) =>
  (prisma.issue.findMany as jest.Mock).mock.calls[0][0].where;

describe('IssuesService.getIssues tenancy', () => {
  it('scopes to the session workspace when no filters are given', async () => {
    const { service, prisma } = buildService();

    await service.getIssues(SESSION_WORKSPACE);

    expect(whereOf(prisma).team).toEqual({ workspaceId: SESSION_WORKSPACE });
  });

  it('never issues an unscoped query when issueIds is omitted', async () => {
    const { service, prisma } = buildService();

    await service.getIssues(SESSION_WORKSPACE, {});

    const where = whereOf(prisma);
    expect(where).not.toEqual({});
    expect(where.team.workspaceId).toBe(SESSION_WORKSPACE);
    // An `id: { in: undefined }` would be dropped by Prisma and widen the scope.
    expect(where.id).toBeUndefined();
  });

  it('rejects a session with no workspace rather than querying unscoped', async () => {
    const { service, prisma } = buildService();

    await expect(service.getIssues(undefined)).rejects.toThrow();
    await expect(service.getIssues('')).rejects.toThrow();
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
  });

  it('nests teamId under team so a foreign team cannot widen the scope', async () => {
    const { service, prisma } = buildService();

    await service.getIssues(SESSION_WORKSPACE, { teamId: 'team-elsewhere' });

    expect(whereOf(prisma).team).toEqual({
      workspaceId: SESSION_WORKSPACE,
      id: 'team-elsewhere',
    });
  });

  it('still narrows by issueIds when they are supplied', async () => {
    const { service, prisma } = buildService();

    await service.getIssues(SESSION_WORKSPACE, { issueIds: ['a', 'b'] });

    const where = whereOf(prisma);
    expect(where.id).toEqual({ in: ['a', 'b'] });
    expect(where.team.workspaceId).toBe(SESSION_WORKSPACE);
  });
});

describe('IssuesService.getIssuesByFilter tenancy', () => {
  it('ignores a workspaceId supplied in the request body', async () => {
    const { service, prisma } = buildService();

    await service.getIssuesByFilter(
      { filters: {}, workspaceId: OTHER_WORKSPACE } as GetIssuesByFilterDTO,
      SESSION_WORKSPACE,
    );

    expect(whereOf(prisma).team).toEqual({ workspaceId: SESSION_WORKSPACE });
  });
});

describe('getFilterWhere', () => {
  it('always scopes to the workspace it is given', () => {
    const where = getFilterWhere(
      { filters: {} } as GetIssuesByFilterDTO,
      SESSION_WORKSPACE,
    );

    expect(where.team).toEqual({ workspaceId: SESSION_WORKSPACE });
  });

  it('refuses to build an unscoped where', () => {
    expect(() =>
      getFilterWhere({ filters: {} } as GetIssuesByFilterDTO, undefined),
    ).toThrow();
    expect(() =>
      getFilterWhere({ filters: {} } as GetIssuesByFilterDTO, ''),
    ).toThrow();
  });
});
