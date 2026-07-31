import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

/**
 * A team is a visibility boundary.
 *
 * This is the decision that ENG-79 records. A workspace is still the tenant:
 * nothing crosses one. Inside a workspace, a person reads the issues of the
 * teams that person belongs to, and no others. `UsersOnWorkspaces.teamIds`
 * holds that membership, and it is the only thing this file reads.
 *
 * The boundary holds where the data is served, and not where it is drawn. A
 * client keeps every record the sync engine gives it in its own IndexedDB, so a
 * screen that filters what it shows hides nothing at all — the record is
 * already on the machine. There are four places that serve, and each one
 * applies this filter:
 *
 * 1. `SyncActionsService.getBootstrap` and `getDelta`, which fill that cache.
 * 2. `SyncGateway` and `ReplicationService`, which push a change as it happens.
 * 3. `WorkspaceResourceGuard`, which stands in front of the routes that name a
 *    record by id.
 * 4. `getFilterWhere` and `VectorService`, which serve the lists and the search
 *    that an agent reads over the API.
 *
 * A record that no team owns, such as a Label or a Page, is workspace-wide and
 * reaches every member.
 */

/**
 * The models whose records one team owns.
 *
 * Everything that hangs off an issue is here, and not the issue alone. A
 * comment body and a history entry say more about the work than the title
 * does, so a boundary that covered only `Issue` would hide the smaller half.
 */
export const TEAM_OWNED_MODELS = [
  'Team',
  'Issue',
  'Cycle',
  'Workflow',
  'IssueComment',
  'ChecklistItem',
  'IssueHistory',
  'LinkedIssue',
  'IssueRelation',
  'IssueSuggestion',
  'Support',
] as const;

/**
 * This function returns the teams that one member of a workspace can see.
 *
 * The caller must prove the workspace first, with `resolveWorkspaceId`. This
 * function answers a narrower question and does not repeat that proof.
 *
 * A member with no team sees no team-owned record. That is the correct answer
 * and not a fault: the membership row says the person joined no team.
 */
export async function visibleTeamIds(
  prisma: PrismaService,
  userId: string,
  workspaceId: string,
): Promise<string[]> {
  const membership = await prisma.usersOnWorkspaces.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { teamIds: true },
  });

  return membership?.teamIds ?? [];
}

/**
 * This function returns the teams whose *own record* one caller may read.
 *
 * This is a wider question than `visibleTeamIds`, and the difference is the
 * decision ENG-82 records. `visibleTeamIds` answers "whose issues may I read",
 * and the answer is the caller's own teams — nothing widens it. This answers
 * "whose name, identifier, preferences and roster may I read", and there an
 * admin reads every team in the workspace, by role rather than by membership.
 *
 * The reason is that the two cannot be the same answer here. `createTeam` adds
 * every admin at the time to a new team, but an admin who predates a team is
 * not in it — so narrowing the roster routes to membership alone would take the
 * team management screen away from exactly the person who administers it. The
 * alternative considered was backfilling every admin into every team, which
 * keeps membership as the single source of truth; it was not taken, because it
 * makes "admin" mean "reads every team's issues" permanently and by accident,
 * rather than by a policy anyone chose.
 *
 * **So the role widens the roster and never the content.** An admin reading a
 * team's name here still reads only their own teams' issues through
 * `visibleTeamIds`, which no role touches. Anything that serves team-owned
 * *records* must keep calling `visibleTeamIds`; this function is only for the
 * `/v1/teams` routes, which serve the team object itself.
 */
export async function readableTeamIds(
  prisma: PrismaService,
  userId: string,
  workspaceId: string,
): Promise<string[]> {
  const membership = await prisma.usersOnWorkspaces.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { teamIds: true, role: true },
  });

  if (!membership) {
    return [];
  }

  if (membership.role !== 'ADMIN') {
    return membership.teamIds ?? [];
  }

  const teams = await prisma.team.findMany({
    where: { workspaceId, deleted: null },
    select: { id: true },
  });

  return teams.map((team) => team.id);
}

/**
 * This function returns the name of the socket room for one team.
 *
 * The room carries the workspace as well as the team, because a team id is
 * enough on its own only while it is a uuid. A room name is a plain string that
 * two workspaces must never share.
 */
export function teamRoom(workspaceId: string, teamId: string): string {
  return `${workspaceId}:${teamId}`;
}

/**
 * This function returns the room that one announcement goes to.
 *
 * With no team the record is workspace-wide, and the room is the workspace.
 */
export function announcementRoom(
  workspaceId: string,
  teamId?: string | null,
): string {
  return teamId ? teamRoom(workspaceId, teamId) : workspaceId;
}

/**
 * This function returns the `where` clause that limits a read to visible teams.
 *
 * A null team means no team owns the record, so every member of the workspace
 * reads it. An empty `teamIds` therefore still returns the workspace-wide
 * records, and none of the team-owned ones.
 *
 * There is one residue, and it is bounded. The migration that added the column
 * backfilled it by a join to each model, which cannot resolve a record that was
 * physically deleted before the migration ran: the row is gone, so no join
 * finds its team. Those announcements keep a null team and reach the whole
 * workspace. They carry nothing: `getSyncActionsData` drops an insert or an
 * update whose record it cannot read, and a delete carries only the id of a
 * record that no longer exists. Every announcement written after the migration
 * carries its team, a delete included, because `teamOfDeleted` recovers it from
 * the insert that named it.
 */
export function syncActionTeamWhere(teamIds: string[]) {
  return { OR: [{ teamId: null }, { teamId: { in: teamIds } }] };
}

/**
 * This function proves that each issue sits in a team the caller can see.
 *
 * One query for all the ids. The error is not-found and not forbidden, for the
 * same reason the workspace checks give not-found: a hidden id and an
 * imaginary one must look the same, or the error itself tells the caller which
 * issues other teams hold.
 */
export async function assertIssuesVisible(
  prisma: PrismaService,
  issueIds: string[],
  teamIds: string[],
): Promise<void> {
  if (issueIds.length === 0) {
    return;
  }

  const visible = await prisma.issue.findMany({
    where: { id: { in: issueIds }, teamId: { in: teamIds } },
    select: { id: true },
  });
  const found = new Set(visible.map((issue) => issue.id));
  const missing = issueIds.find((id) => !found.has(id));

  if (missing) {
    throw new NotFoundException({ message: `Issue ${missing} not found` });
  }
}

/** This function proves that each team named in a request is a visible one. */
export async function assertTeamsVisible(
  teamIds: string[],
  visible: string[],
): Promise<void> {
  const allowed = new Set(visible);
  const missing = teamIds.find((id) => !allowed.has(id));

  if (missing) {
    throw new NotFoundException({ message: `Team ${missing} not found` });
  }
}

/**
 * This function proves that each comment sits in a team the caller can see.
 */
export async function assertIssueCommentsVisible(
  prisma: PrismaService,
  commentIds: string[],
  teamIds: string[],
): Promise<void> {
  if (commentIds.length === 0) {
    return;
  }

  const visible = await prisma.issueComment.findMany({
    where: { id: { in: commentIds }, issue: { teamId: { in: teamIds } } },
    select: { id: true },
  });
  const found = new Set(visible.map((comment) => comment.id));
  const missing = commentIds.find((id) => !found.has(id));

  if (missing) {
    throw new NotFoundException({
      message: `Issue comment ${missing} not found`,
    });
  }
}

/**
 * This function proves that each checklist item sits in a visible team.
 */
export async function assertChecklistItemsVisible(
  prisma: PrismaService,
  itemIds: string[],
  teamIds: string[],
): Promise<void> {
  if (itemIds.length === 0) {
    return;
  }

  const visible = await prisma.checklistItem.findMany({
    where: { id: { in: itemIds }, issue: { teamId: { in: teamIds } } },
    select: { id: true },
  });
  const found = new Set(visible.map((item) => item.id));
  const missing = itemIds.find((id) => !found.has(id));

  if (missing) {
    throw new NotFoundException({
      message: `Checklist item ${missing} not found`,
    });
  }
}

/** This function proves that each cycle sits in a team the caller can see. */
export async function assertCyclesVisible(
  prisma: PrismaService,
  cycleIds: string[],
  teamIds: string[],
): Promise<void> {
  if (cycleIds.length === 0) {
    return;
  }

  const visible = await prisma.cycle.findMany({
    where: { id: { in: cycleIds }, teamId: { in: teamIds } },
    select: { id: true },
  });
  const found = new Set(visible.map((cycle) => cycle.id));
  const missing = cycleIds.find((id) => !found.has(id));

  if (missing) {
    throw new NotFoundException({ message: `Cycle ${missing} not found` });
  }
}
