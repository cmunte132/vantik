import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import {
  announcementRoom,
  assertIssuesVisible,
  assertTeamsVisible,
  syncActionTeamWhere,
  teamRoom,
  visibleTeamIds,
} from './team-access';

const USER = 'user-1';
const WORKSPACE = 'workspace-1';
const TEAM_OWN = 'team-own';
const TEAM_OTHER = 'team-other';

describe('visibleTeamIds', () => {
  function buildPrisma(membership: { teamIds: string[] } | null) {
    return {
      usersOnWorkspaces: { findUnique: jest.fn(async () => membership) },
    } as unknown as PrismaService;
  }

  it('returns the teams of the membership', async () => {
    const prisma = buildPrisma({ teamIds: [TEAM_OWN, TEAM_OTHER] });

    await expect(visibleTeamIds(prisma, USER, WORKSPACE)).resolves.toEqual([
      TEAM_OWN,
      TEAM_OTHER,
    ]);
  });

  /**
   * A member who joined no team sees no team-owned record. That is the correct
   * answer and not a fault, so it must be an empty list and never undefined —
   * an undefined value dropped into a Prisma `where` widens the read to the
   * whole workspace, which is the shape of every leak this code exists to stop.
   */
  it('returns an empty list for a member of no team', async () => {
    const prisma = buildPrisma({ teamIds: [] });

    await expect(visibleTeamIds(prisma, USER, WORKSPACE)).resolves.toEqual([]);
  });

  it('returns an empty list when there is no membership at all', async () => {
    const prisma = buildPrisma(null);

    await expect(visibleTeamIds(prisma, USER, WORKSPACE)).resolves.toEqual([]);
  });
});

describe('syncActionTeamWhere', () => {
  /**
   * A null team means no team owns the record. A Label, a Page and a Project
   * are workspace-wide, and a clause that dropped them would take the shared
   * data away from everybody.
   */
  it('keeps the records that no team owns', () => {
    expect(syncActionTeamWhere([TEAM_OWN])).toEqual({
      OR: [{ teamId: null }, { teamId: { in: [TEAM_OWN] } }],
    });
  });

  it('still keeps them for a member of no team', () => {
    expect(syncActionTeamWhere([])).toEqual({
      OR: [{ teamId: null }, { teamId: { in: [] } }],
    });
  });
});

describe('the room of an announcement', () => {
  it('carries the workspace as well as the team', () => {
    // A team id is enough on its own only while it is a uuid. A room name is a
    // plain string that two workspaces must never share.
    expect(teamRoom(WORKSPACE, TEAM_OWN)).toBe(`${WORKSPACE}:${TEAM_OWN}`);
  });

  it('is the team room for a record that a team owns', () => {
    expect(announcementRoom(WORKSPACE, TEAM_OWN)).toBe(
      `${WORKSPACE}:${TEAM_OWN}`,
    );
  });

  it('is the workspace room for a record that no team owns', () => {
    expect(announcementRoom(WORKSPACE, null)).toBe(WORKSPACE);
    expect(announcementRoom(WORKSPACE)).toBe(WORKSPACE);
  });
});

describe('assertIssuesVisible', () => {
  function buildPrisma(visible: string[]) {
    return {
      issue: {
        findMany: jest.fn(async ({ where }) =>
          where.id.in
            .filter((id: string) => visible.includes(id))
            .map((id: string) => ({ id })),
        ),
      },
    } as unknown as PrismaService;
  }

  it('passes when every issue is in a visible team', async () => {
    const prisma = buildPrisma(['issue-1', 'issue-2']);

    await expect(
      assertIssuesVisible(prisma, ['issue-1', 'issue-2'], [TEAM_OWN]),
    ).resolves.toBeUndefined();
  });

  it('refuses the whole request when one issue is hidden', async () => {
    const prisma = buildPrisma(['issue-1']);

    // A bulk write that dropped the hidden id and carried on would edit the
    // rest, which is a partial write nobody asked for.
    await expect(
      assertIssuesVisible(prisma, ['issue-1', 'issue-hidden'], [TEAM_OWN]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads nothing when there are no ids to check', async () => {
    const prisma = buildPrisma([]);

    await expect(
      assertIssuesVisible(prisma, [], [TEAM_OWN]),
    ).resolves.toBeUndefined();
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
  });

  it('says not found rather than forbidden', async () => {
    const prisma = buildPrisma([]);

    // A hidden id and an imaginary one must look the same, or the error itself
    // tells the caller which issues the other teams hold.
    await expect(
      assertIssuesVisible(prisma, ['issue-hidden'], [TEAM_OWN]),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('assertTeamsVisible', () => {
  it('passes for a team the caller belongs to', async () => {
    await expect(
      assertTeamsVisible([TEAM_OWN], [TEAM_OWN, TEAM_OTHER]),
    ).resolves.toBeUndefined();
  });

  it('refuses a team the caller does not belong to', async () => {
    await expect(
      assertTeamsVisible([TEAM_OTHER], [TEAM_OWN]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes when the request names no team', async () => {
    await expect(assertTeamsVisible([], [])).resolves.toBeUndefined();
  });
});
