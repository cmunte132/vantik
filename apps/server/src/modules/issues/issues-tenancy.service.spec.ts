/**
 * Tenancy scoping for issue reads.
 *
 * Regression cover for a cross-workspace leak: `POST /v1/issues/filter`
 * scoped on a `workspaceId` taken from the request body, which let any
 * authenticated caller read another workspace's issues.
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

  const service = new IssuesService(
    prisma,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  );

  return { service, prisma };
}

const whereOf = (prisma: PrismaService) =>
  (prisma.issue.findMany as jest.Mock).mock.calls[0][0].where;

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

  /**
   * A team is a visibility boundary (ENG-79). This clause is what carries it to
   * the list routes, and so to the MCP tools, which are clients of those same
   * routes rather than a second way into the database.
   */
  describe('the team boundary', () => {
    it('limits the read to the teams it is given', () => {
      const where = getFilterWhere(
        { filters: {} } as GetIssuesByFilterDTO,
        SESSION_WORKSPACE,
        ['team-own'],
      );

      expect(where.teamId).toEqual({ in: ['team-own'] });
    });

    it('returns nothing for a caller in no team', () => {
      const where = getFilterWhere(
        { filters: {} } as GetIssuesByFilterDTO,
        SESSION_WORKSPACE,
        [],
      );

      // An empty list, and not an absent clause. `teamId: { in: [] }` matches
      // no row; leaving the key off would match every row in the workspace.
      expect(where.teamId).toEqual({ in: [] });
    });

    it('leaves the read unlimited when no teams are given', () => {
      // The internal callers serve no user and legitimately read the whole
      // workspace, so an absent list must not become an empty one.
      const where = getFilterWhere(
        { filters: {} } as GetIssuesByFilterDTO,
        SESSION_WORKSPACE,
      );

      expect(where.teamId).toBeUndefined();
    });
  });
});
