import { ExecutionContext, NotFoundException } from '@nestjs/common';

import { WorkspaceResourceGuard } from './workspace-resource.guard';

const USER = 'user-self';
const OWN_WORKSPACE = 'workspace-own';

const OWN_ISSUE = 'issue-own';
const FOREIGN_ISSUE = 'issue-foreign';
const OWN_TEAM = 'team-own';
const FOREIGN_TEAM = 'team-foreign';
const OWN_COMMENT = 'comment-own';
const FOREIGN_COMMENT = 'comment-foreign';
const OWN_MODULE = 'module-own';
const FOREIGN_MODULE = 'module-foreign';
const OWN_CAPABILITY = 'capability-own';
const FOREIGN_CAPABILITY = 'capability-foreign';
const OWN_REPO = 'repo-own';
const FOREIGN_REPO = 'repo-foreign';

// A team is a visibility boundary inside the workspace (ENG-79). These three
// sit in OWN_WORKSPACE and pass every workspace check; the team check is the
// only thing that separates them.
const OTHER_TEAM = 'team-other';
const OTHER_TEAM_ISSUE = 'issue-other-team';
const OTHER_TEAM_COMMENT = 'comment-other-team';

/**
 * Rows are keyed by id; the fixtures place the "own" ones in OWN_WORKSPACE and
 * the "foreign" ones elsewhere, so a query filtered by workspace finds only the
 * former — the same way the real `where` clauses behave.
 */
function buildPrisma(callerTeamIds: string[] = [OWN_TEAM]) {
  const inWorkspace = (id: string) =>
    [
      OWN_ISSUE,
      OWN_TEAM,
      OWN_COMMENT,
      OWN_MODULE,
      OWN_CAPABILITY,
      OWN_REPO,
      OTHER_TEAM,
      OTHER_TEAM_ISSUE,
      OTHER_TEAM_COMMENT,
    ].includes(id);

  const finder =
    () =>
    async ({ where }: { where: { id: string } }) =>
      inWorkspace(where.id) ? { id: where.id } : null;

  // The team of each row that a team owns.
  const teamOf: Record<string, string> = {
    [OWN_ISSUE]: OWN_TEAM,
    [OWN_COMMENT]: OWN_TEAM,
    [OTHER_TEAM_ISSUE]: OTHER_TEAM,
    [OTHER_TEAM_COMMENT]: OTHER_TEAM,
  };

  // Stands in for `teamId: { in: [...] }`, and for the same clause reached
  // through `issue: { teamId: { in: [...] } }` on a comment or an item.
  const visibleFinder =
    () =>
    async ({
      where,
    }: {
      where: {
        id: { in: string[] };
        teamId?: { in: string[] };
        issue?: { teamId: { in: string[] } };
      };
    }) => {
      const allowed = (where.teamId ?? where.issue?.teamId)?.in ?? [];

      return where.id.in
        .filter((id) => allowed.includes(teamOf[id]))
        .map((id) => ({ id }));
    };

  return {
    usersOnWorkspaces: {
      findUnique: jest.fn(async () => ({
        status: 'ACTIVE',
        teamIds: callerTeamIds,
      })),
    },
    issue: { findFirst: jest.fn(finder()), findMany: jest.fn(visibleFinder()) },
    team: { findFirst: jest.fn(finder()) },
    issueComment: {
      findFirst: jest.fn(finder()),
      findMany: jest.fn(visibleFinder()),
    },
    checklistItem: { findMany: jest.fn(visibleFinder()) },
    cycle: { findMany: jest.fn(visibleFinder()) },
    module: { findFirst: jest.fn(finder()) },
    capability: { findFirst: jest.fn(finder()) },
    product: { findFirst: jest.fn(finder()) },
    project: { findFirst: jest.fn(finder()) },
    integrationAccount: { findFirst: jest.fn(finder()) },
    // A repository is found only when it is in the workspace *and* hangs off
    // the module the path names, which is the pair the real query checks.
    moduleRepo: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; moduleId?: string } }) =>
          inWorkspace(where.id) && where.moduleId === OWN_MODULE
            ? { id: where.id }
            : null,
      ),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function buildContext({
  params = {},
  query = {},
  body = {},
}: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: Record<string, any>;
}) {
  const request = {
    params,
    query,
    body,
    session: {
      getUserId: () => USER,
      getAccessTokenPayload: () => ({
        appUserId: USER,
        workspaceId: OWN_WORKSPACE,
      }),
    },
  };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('WorkspaceResourceGuard', () => {
  let guard: WorkspaceResourceGuard;

  beforeEach(() => {
    guard = new WorkspaceResourceGuard(buildPrisma());
  });

  it('allows an issue in the caller-s workspace', async () => {
    const ctx = buildContext({ params: { issueId: OWN_ISSUE } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a foreign issue id as not found', async () => {
    const ctx = buildContext({ params: { issueId: FOREIGN_ISSUE } });

    // Not-found rather than forbidden: a distinguishable error would confirm
    // which ids exist in other workspaces.
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a foreign comment id', async () => {
    const ctx = buildContext({ params: { issueCommentId: FOREIGN_COMMENT } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('allows a comment in the caller-s workspace', async () => {
    const ctx = buildContext({ params: { issueCommentId: OWN_COMMENT } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a foreign issueId passed as a query param', async () => {
    // Comment creation is POST /issue_comments?issueId=…, so the issue it
    // writes to never appears in the path.
    const ctx = buildContext({ query: { issueId: FOREIGN_ISSUE } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('allows a query issueId in the caller-s workspace', async () => {
    const ctx = buildContext({ query: { issueId: OWN_ISSUE } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a foreign teamId passed as a query param', async () => {
    const ctx = buildContext({ query: { teamId: FOREIGN_TEAM } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a foreign teamId passed in the body', async () => {
    // The create and move paths take the destination team from the body, so an
    // unchecked one writes into another workspace.
    const ctx = buildContext({ body: { teamId: FOREIGN_TEAM } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a foreign issue hidden inside a bulk update body', async () => {
    const ctx = buildContext({
      query: { teamId: OWN_TEAM },
      body: { issues: [{ issueId: OWN_ISSUE }, { issueId: FOREIGN_ISSUE }] },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a foreign team hidden inside a bulk create body', async () => {
    const ctx = buildContext({
      body: { issues: [{ teamId: OWN_TEAM }, { teamId: FOREIGN_TEAM }] },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('allows a bulk body whose entries are all in the workspace', async () => {
    const ctx = buildContext({
      query: { teamId: OWN_TEAM },
      body: { issues: [{ issueId: OWN_ISSUE }, { issueId: OWN_ISSUE }] },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('passes when the request names no scoped resource', async () => {
    const ctx = buildContext({});

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  /**
   * A module repository carries no workspace of its own — only the module above
   * it does. So the repository routes were guarded on the `:moduleId` beside the
   * id, which proved nothing about the id itself: a caller naming a module of
   * their own and a repository row of anybody's rewrote that row's path
   * prefixes, and the prefixes are what route a pull request to a module.
   */
  describe('module repositories', () => {
    it('allows a repository that hangs off the module in the path', async () => {
      const ctx = buildContext({
        params: { moduleId: OWN_MODULE, moduleRepoId: OWN_REPO },
      });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('rejects a foreign repository named beside a module of the caller', async () => {
      const ctx = buildContext({
        params: { moduleId: OWN_MODULE, moduleRepoId: FOREIGN_REPO },
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a repository that belongs to a different module', async () => {
      const ctx = buildContext({
        params: { moduleId: FOREIGN_MODULE, moduleRepoId: OWN_REPO },
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a foreign integration account named in the body', async () => {
      const ctx = buildContext({
        params: { moduleId: OWN_MODULE },
        body: { integrationAccountId: 'account-foreign' },
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /**
   * An issue body nests: `subIssues` on any issue, and `issues` on the bulk
   * routes. Reading only the top level checked the parent and none of the
   * children, and `Issue.moduleIds` has no foreign key behind it, so this guard
   * is the only thing between that column and any id a caller sends.
   */
  describe('the product axis inside a nested body', () => {
    it('rejects a foreign module hidden on a sub-issue', async () => {
      const ctx = buildContext({
        body: {
          teamId: OWN_TEAM,
          subIssues: [{ moduleIds: [FOREIGN_MODULE] }],
        },
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a foreign capability hidden on a sub-issue', async () => {
      const ctx = buildContext({
        body: {
          teamId: OWN_TEAM,
          subIssues: [{ capabilityId: FOREIGN_CAPABILITY }],
        },
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a foreign module two levels down', async () => {
      const ctx = buildContext({
        body: {
          subIssues: [{ subIssues: [{ moduleIds: [FOREIGN_MODULE] }] }],
        },
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a foreign module inside a bulk create body', async () => {
      const ctx = buildContext({
        body: {
          issues: [
            { teamId: OWN_TEAM, moduleIds: [OWN_MODULE] },
            { teamId: OWN_TEAM, moduleIds: [FOREIGN_MODULE] },
          ],
        },
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('allows a nested body whose axis ids are all in the workspace', async () => {
      const ctx = buildContext({
        body: {
          teamId: OWN_TEAM,
          moduleIds: [OWN_MODULE],
          capabilityId: OWN_CAPABILITY,
          subIssues: [
            { moduleIds: [OWN_MODULE], capabilityId: OWN_CAPABILITY },
          ],
        },
      });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('rejects a foreign capability in a project-s capabilityIds', async () => {
      const ctx = buildContext({
        body: { capabilityIds: [OWN_CAPABILITY, FOREIGN_CAPABILITY] },
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    /**
     * A body built to make the walk expensive is refused by the depth limit
     * rather than followed. Nothing the app sends nests anywhere near this far.
     */
    it('does not follow a body nested past the depth limit', async () => {
      let body = { moduleIds: [FOREIGN_MODULE] };

      for (let depth = 0; depth < 40; depth++) {
        body = { subIssues: [body] } as never;
      }

      const ctx = buildContext({ body });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });
});

/**
 * A team is a visibility boundary inside the workspace (ENG-79).
 *
 * Every id below is in the caller's own workspace and passes every check that
 * existed before. The team check is the only thing that separates them, which
 * is why they sit in their own block: a workspace fixture that also happened to
 * be foreign would prove nothing about the team.
 */
describe('WorkspaceResourceGuard team boundary', () => {
  it('allows an issue of a team the caller belongs to', async () => {
    const guard = new WorkspaceResourceGuard(buildPrisma([OWN_TEAM]));
    const ctx = buildContext({ params: { issueId: OWN_ISSUE } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects an issue of another team as not found', async () => {
    const guard = new WorkspaceResourceGuard(buildPrisma([OWN_TEAM]));
    const ctx = buildContext({ params: { issueId: OTHER_TEAM_ISSUE } });

    // Not-found and not forbidden, for the reason the workspace checks give it:
    // a hidden id and an imaginary one must look the same.
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a comment on an issue of another team', async () => {
    const guard = new WorkspaceResourceGuard(buildPrisma([OWN_TEAM]));
    const ctx = buildContext({
      params: { issueCommentId: OTHER_TEAM_COMMENT },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a write that names another team', async () => {
    const guard = new WorkspaceResourceGuard(buildPrisma([OWN_TEAM]));
    const ctx = buildContext({ query: { teamId: OTHER_TEAM } });

    // A create names its team in the body and an update in the query. Without
    // this the caller writes an issue into a team they cannot read.
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an issue in a bulk body that belongs to another team', async () => {
    const guard = new WorkspaceResourceGuard(buildPrisma([OWN_TEAM]));
    const ctx = buildContext({
      body: { issues: [{ issueId: OWN_ISSUE }, { issueId: OTHER_TEAM_ISSUE }] },
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects every team-owned id for a caller in no team', async () => {
    const guard = new WorkspaceResourceGuard(buildPrisma([]));
    const ctx = buildContext({ params: { issueId: OWN_ISSUE } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * A module, a capability and a product belong to the workspace and not to a
   * team. The boundary must not reach them, or the axis screens would break for
   * everyone.
   */
  it('leaves the workspace-wide ids alone', async () => {
    const guard = new WorkspaceResourceGuard(buildPrisma([]));
    const ctx = buildContext({
      params: { moduleId: OWN_MODULE, capabilityId: OWN_CAPABILITY },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
