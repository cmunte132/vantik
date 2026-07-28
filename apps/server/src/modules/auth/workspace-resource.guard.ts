import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { SessionContainer } from 'supertokens-node/recipe/session';

import {
  assertChecklistItemsVisible,
  assertCyclesVisible,
  assertIssueCommentsVisible,
  assertIssuesVisible,
  assertTeamsVisible,
  visibleTeamIds,
} from 'common/team-access';
import {
  assertCapabilityInWorkspace,
  assertChecklistItemInWorkspace,
  assertCycleInWorkspace,
  assertIntegrationAccountInWorkspace,
  assertIssueCommentInWorkspace,
  assertIssueInWorkspace,
  assertModuleInWorkspace,
  assertModuleRepoInWorkspace,
  assertPageEntryInWorkspace,
  assertPageInWorkspace,
  assertProductInWorkspace,
  assertProjectInWorkspace,
  assertTeamInWorkspace,
  resolveWorkspaceId,
} from 'common/workspace-access';

import { getAppUserId } from 'modules/auth/session-user';

/**
 * Proves that the issue, comment or team named in a request belongs to a
 * workspace the caller is a member of.
 *
 * AuthGuard proves only that the caller is *some* valid user, so any endpoint
 * addressing a row by id — `GET /issues/:issueId`, `POST /issues/:issueId`,
 * the comment routes — served or modified that row whatever workspace it sat
 * in. Reads leaked issue contents; the writes were worse, since a foreign id
 * could be updated, deleted or moved.
 *
 * The check lives at the HTTP boundary rather than in the services because
 * that is where the untrusted id arrives. The same service methods are called
 * internally — `updateIssueApi` from projects.service, `moveIssue` from itself
 * for sub-issues — with no user session and a legitimate need to cross
 * workspaces, so a membership check inside them would be wrong.
 *
 * Use after AuthGuard, which populates the session this reads.
 */
@Injectable()
export class WorkspaceResourceGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const session = request.session as SessionContainer;

    const userId = getAppUserId(session);
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      session.getAccessTokenPayload().workspaceId,
      request.query?.workspaceId,
    );

    const {
      issueId,
      issueCommentId,
      checklistItemId,
      pageEntryId,
      cycleId,
      projectId,
      productId,
      moduleId,
      moduleRepoId,
      capabilityId,
    } = request.params ?? {};

    // The bulk routes carry their ids inside a body array, one per issue, so
    // the path and query alone do not describe everything the request touches.
    // An issue also carries its own sub-issues, and each of those is a whole
    // issue body again — so the ids of a write are the ids of a tree, not of
    // one object. Reading only the top level let a caller hang a foreign module
    // or capability off a sub-issue, which is the same hole one level down.
    const bodies = issueBodies(request.body);

    // Comment creation names its issue in the query rather than the path, so
    // a guard reading only params would let a caller comment on an issue in
    // another workspace.
    const issueIds = unique([
      issueId,
      request.query?.issueId,
      ...bodies.map((body) => body?.issueId),
    ]);

    // teamId selects the team a write lands in: a query param on update, the
    // body on create and move, and per-entry on bulk create.
    const requestTeamIds = unique([
      request.query?.teamId,
      ...bodies.map((body) => body?.teamId),
    ]);

    for (const id of issueIds) {
      await assertIssueInWorkspace(this.prisma, id, workspaceId);
    }

    for (const id of requestTeamIds) {
      await assertTeamInWorkspace(this.prisma, id, workspaceId);
    }

    if (issueCommentId) {
      await assertIssueCommentInWorkspace(
        this.prisma,
        issueCommentId,
        workspaceId,
      );
    }

    // Same shape as the checklist items below: start, complete and delete name
    // the cycle by id and nothing else, and completing one moves other people's
    // issues around.
    if (cycleId) {
      await assertCycleInWorkspace(this.prisma, cycleId, workspaceId);
    }

    // Checklist item updates and deletes address the row by id alone, with no
    // issueId anywhere in the request, so without this a foreign item could be
    // ticked or removed.
    if (checklistItemId) {
      await assertChecklistItemInWorkspace(
        this.prisma,
        checklistItemId,
        workspaceId,
      );
    }

    // Pages are reached by path on read and edit, and by query when appending
    // an entry — the same split the comment routes have, and the same reason to
    // check both rather than only params. A `parentId` in the body is
    // deliberately not checked here: the issue routes use that name for an
    // issue, so the page reparent path validates its own parent instead.
    const pageIds = unique([request.params?.pageId, request.query?.pageId]);

    for (const id of pageIds) {
      await assertPageInWorkspace(this.prisma, id, workspaceId);
    }

    // Entry triage addresses the row by id alone, with no page anywhere in the
    // request, so without this a foreign fact could be accepted or archived.
    const entryIds = unique([
      pageEntryId,
      request.body?.supersedesId,
      ...(Array.isArray(request.body?.entryIds) ? request.body.entryIds : []),
    ]);

    for (const id of entryIds) {
      await assertPageEntryInWorkspace(this.prisma, id, workspaceId);
    }

    // The product axis. Each of the three is addressed by id on update and
    // delete, the same shape as the cycle routes. The bodies matter as much as
    // the paths: a module names its owner and its links by id, and a capability
    // names the modules that hold its code, so a write with a foreign id would
    // pull another workspace's rows into this one's graph.
    const productIds = unique([
      productId,
      ...bodies.map((body) => body?.ownerProductId),
      ...bodies.flatMap((body) => list(body?.linkedProductIds)),
    ]);

    for (const id of productIds) {
      await assertProductInWorkspace(this.prisma, id, workspaceId);
    }

    // Issue.moduleIds is a plain string array with no foreign key behind it, so
    // this check is the only thing standing between the column and any id a
    // caller cares to send.
    const moduleIds = unique([
      moduleId,
      ...bodies.flatMap((body) => list(body?.moduleIds)),
    ]);

    for (const id of moduleIds) {
      await assertModuleInWorkspace(this.prisma, id, workspaceId);
    }

    // A module repository is addressed by its own id, and the row carries no
    // workspace — only the module above it does. So the check needs both ids,
    // and proving the module alone proves nothing about the repository.
    if (moduleRepoId) {
      await assertModuleRepoInWorkspace(
        this.prisma,
        moduleRepoId,
        moduleId,
        workspaceId,
      );
    }

    const integrationAccountIds = unique(
      bodies.map((body) => body?.integrationAccountId),
    );

    for (const id of integrationAccountIds) {
      await assertIntegrationAccountInWorkspace(this.prisma, id, workspaceId);
    }

    const capabilityIds = unique([
      capabilityId,
      ...bodies.map((body) => body?.capabilityId),
      ...bodies.flatMap((body) => list(body?.capabilityIds)),
    ]);

    for (const id of capabilityIds) {
      await assertCapabilityInWorkspace(this.prisma, id, workspaceId);
    }

    // A module names its owning team, and a link names any number of teams. A
    // project names the teams working on it in `teams`. All go through the same
    // team check the issue routes use.
    const linkedTeamIds = unique([
      ...bodies.map((body) => body?.ownerTeamId),
      ...bodies.flatMap((body) => list(body?.linkedTeamIds)),
      ...bodies.flatMap((body) => list(body?.teams)),
    ]);

    for (const id of linkedTeamIds) {
      await assertTeamInWorkspace(this.prisma, id, workspaceId);
    }

    // A project is addressed by id on update and delete, and it now names the
    // capabilities it builds, so the row has to be proved before the body is
    // written into it.
    const projectIds = unique([projectId, request.query?.projectId]);

    for (const id of projectIds) {
      await assertProjectInWorkspace(this.prisma, id, workspaceId);
    }

    // A team is a visibility boundary inside the workspace (ENG-79), so the
    // checks above are necessary and not sufficient: they prove the row is a
    // tenant's own, and say nothing about whether this caller may see it. Every
    // id that names a team-owned row is checked again here, against the teams
    // the caller belongs to.
    //
    // This runs last so the answers stay consistent. A row of another workspace
    // and a row of another team both give not-found, and the workspace check
    // gets there first for the ids it covers.
    const teamIds = await visibleTeamIds(this.prisma, userId, workspaceId);

    await assertTeamsVisible([...linkedTeamIds, ...requestTeamIds], teamIds);
    await assertIssuesVisible(this.prisma, issueIds, teamIds);
    await assertIssueCommentsVisible(
      this.prisma,
      issueCommentId ? [issueCommentId] : [],
      teamIds,
    );
    await assertChecklistItemsVisible(
      this.prisma,
      checklistItemId ? [checklistItemId] : [],
      teamIds,
    );
    await assertCyclesVisible(this.prisma, cycleId ? [cycleId] : [], teamIds);

    return true;
  }
}

/** One object in a request body that can carry ids this guard checks. */
interface IdBearingBody {
  issueId?: string;
  teamId?: string;
  ownerTeamId?: string;
  ownerProductId?: string;
  capabilityId?: string;
  integrationAccountId?: string;
  moduleIds?: unknown;
  capabilityIds?: unknown;
  linkedTeamIds?: unknown;
  linkedProductIds?: unknown;
  teams?: unknown;
  issues?: unknown;
  subIssues?: unknown;
}

/** The depth beyond which a body is refused rather than walked. */
const MAX_ISSUE_DEPTH = 10;

/**
 * Flattens a request body into every object whose ids have to be checked.
 *
 * An issue body nests twice over: `issues` on the bulk routes, and `subIssues`
 * on any issue, recursively. A guard that read only the top level checked the
 * ids of the parent and none of the children, so a foreign module or capability
 * arrived on a sub-issue untouched.
 *
 * The depth limit is a guard against a body built to make this walk expensive,
 * not against anything the app itself sends: a person nests a sub-issue once,
 * and never ten deep.
 */
function issueBodies(body: unknown, depth = 0): IdBearingBody[] {
  if (!body || typeof body !== 'object' || depth > MAX_ISSUE_DEPTH) {
    return [];
  }

  const current = body as IdBearingBody;
  const nested = [...list(current.issues), ...list(current.subIssues)];

  return [current, ...nested.flatMap((child) => issueBodies(child, depth + 1))];
}

/** Reads a value that should be an array, and refuses to guess when it is not. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function unique(ids: unknown[]): string[] {
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
}
