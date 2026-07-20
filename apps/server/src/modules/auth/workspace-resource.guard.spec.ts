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

/**
 * Rows are keyed by id; the fixtures place the "own" ones in OWN_WORKSPACE and
 * the "foreign" ones elsewhere, so a query filtered by workspace finds only the
 * former — the same way the real `where` clauses behave.
 */
function buildPrisma() {
  const inWorkspace = (id: string) =>
    [OWN_ISSUE, OWN_TEAM, OWN_COMMENT].includes(id);

  const finder =
    () =>
    async ({ where }: { where: { id: string } }) =>
      inWorkspace(where.id) ? { id: where.id } : null;

  return {
    usersOnWorkspaces: {
      findUnique: jest.fn(async () => ({ status: 'ACTIVE' })),
    },
    issue: { findFirst: jest.fn(finder()) },
    team: { findFirst: jest.fn(finder()) },
    issueComment: { findFirst: jest.fn(finder()) },
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
      getAccessTokenPayload: () => ({ workspaceId: OWN_WORKSPACE }),
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
});
