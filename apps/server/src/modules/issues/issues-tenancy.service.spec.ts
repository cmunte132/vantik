/**
 * Tenancy scoping for issue reads.
 *
 * Regression cover for a cross-workspace leak: `GET /v1/issues` built its
 * `where` from an optional `issueIds` param, so omitting it produced an
 * unfiltered `findMany` over every issue in the deployment, and
 * `POST /v1/issues/filter` scoped on a `workspaceId` taken from the request
 * body, which let any authenticated caller read another workspace's issues.
 *
 * The invariant these tests protect: a read is never issued without a
 * workspace, and the workspace it uses is one the caller actually belongs to.
 * Note that a requested workspace is *honoured* rather than ignored — users can
 * belong to several — so the membership check is what does the work.
 */
import { GetIssuesByFilterDTO } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssuesService from './issues.service';
import { getFilterWhere } from './issues.utils';

const USER = 'user-1';
const SESSION_WORKSPACE = 'workspace-mine';
const OTHER_WORKSPACE = 'workspace-theirs';

/** `memberOf` lists the workspaces the fake user is an ACTIVE member of. */
function buildService(memberOf: string[] = [SESSION_WORKSPACE]) {
  const prisma = {
    issue: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    workflow: { findMany: jest.fn().mockResolvedValue([]) },
    usersOnWorkspaces: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          memberOf.includes(where.userId_workspaceId.workspaceId)
            ? { status: 'ACTIVE' }
            : null,
        ),
      ),
    },
  } as unknown as PrismaService;

  const service = new IssuesService(prisma, null, null, null, null, null, null);

  return { service, prisma };
}

const whereOf = (prisma: PrismaService) =>
  (prisma.issue.findMany as jest.Mock).mock.calls[0][0].where;

describe('IssuesService.getIssues tenancy', () => {
  it('scopes to the session workspace when none is requested', async () => {
    const { service, prisma } = buildService();

    await service.getIssues(SESSION_WORKSPACE, USER);

    expect(whereOf(prisma).team).toEqual({ workspaceId: SESSION_WORKSPACE });
  });

  it('never issues an unscoped query when issueIds is omitted', async () => {
    const { service, prisma } = buildService();

    await service.getIssues(SESSION_WORKSPACE, USER, {});

    const where = whereOf(prisma);
    expect(where).not.toEqual({});
    expect(where.team.workspaceId).toBe(SESSION_WORKSPACE);
    // An `id: { in: undefined }` would be dropped by Prisma and widen the scope.
    expect(where.id).toBeUndefined();
  });

  it('rejects a session with no workspace rather than querying unscoped', async () => {
    const { service, prisma } = buildService();

    await expect(service.getIssues(undefined, USER)).rejects.toThrow();
    await expect(service.getIssues('', USER)).rejects.toThrow();
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
  });

  it('honours a requested workspace the caller belongs to', async () => {
    const { service, prisma } = buildService([
      SESSION_WORKSPACE,
      OTHER_WORKSPACE,
    ]);

    await service.getIssues(SESSION_WORKSPACE, USER, {
      workspaceId: OTHER_WORKSPACE,
    });

    // Multi-workspace users switch via the URL slug, so this must not be
    // forced back to the session's workspace.
    expect(whereOf(prisma).team).toEqual({ workspaceId: OTHER_WORKSPACE });
  });

  it('rejects a requested workspace the caller does not belong to', async () => {
    const { service, prisma } = buildService([SESSION_WORKSPACE]);

    await expect(
      service.getIssues(SESSION_WORKSPACE, USER, {
        workspaceId: OTHER_WORKSPACE,
      }),
    ).rejects.toThrow();
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
  });

  it('nests teamId under team so a foreign team cannot widen the scope', async () => {
    const { service, prisma } = buildService();

    await service.getIssues(SESSION_WORKSPACE, USER, {
      teamId: 'team-elsewhere',
    });

    expect(whereOf(prisma).team).toEqual({
      workspaceId: SESSION_WORKSPACE,
      id: 'team-elsewhere',
    });
  });

  it('still narrows by issueIds when they are supplied', async () => {
    const { service, prisma } = buildService();

    await service.getIssues(SESSION_WORKSPACE, USER, { issueIds: ['a', 'b'] });

    const where = whereOf(prisma);
    expect(where.id).toEqual({ in: ['a', 'b'] });
    expect(where.team.workspaceId).toBe(SESSION_WORKSPACE);
  });
});

describe('IssuesService.getIssuesByFilter tenancy', () => {
  it('rejects a body workspaceId the caller does not belong to', async () => {
    const { service, prisma } = buildService([SESSION_WORKSPACE]);

    await expect(
      service.getIssuesByFilter(
        { filters: {}, workspaceId: OTHER_WORKSPACE } as GetIssuesByFilterDTO,
        SESSION_WORKSPACE,
        USER,
      ),
    ).rejects.toThrow();
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
  });

  it('honours a body workspaceId the caller belongs to', async () => {
    const { service, prisma } = buildService([
      SESSION_WORKSPACE,
      OTHER_WORKSPACE,
    ]);

    await service.getIssuesByFilter(
      { filters: {}, workspaceId: OTHER_WORKSPACE } as GetIssuesByFilterDTO,
      SESSION_WORKSPACE,
      USER,
    );

    expect(whereOf(prisma).team).toEqual({ workspaceId: OTHER_WORKSPACE });
  });

  it('falls back to the session workspace when the body names none', async () => {
    const { service, prisma } = buildService();

    await service.getIssuesByFilter(
      { filters: {} } as GetIssuesByFilterDTO,
      SESSION_WORKSPACE,
      USER,
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
