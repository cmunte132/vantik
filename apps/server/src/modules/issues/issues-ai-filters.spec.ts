/**
 * Team scoping for the AI filter builder.
 *
 * `aiFilters` collects label names, assignee names and workflow states and
 * feeds them to the model that builds a filter. Asked with no team it used to
 * collect them from **every team in the workspace**.
 *
 * ENG-79 left this alone because what comes back is a filter object rather
 * than issue content. That reasoning only goes so far: the labels another team
 * invented and the names of the people on it are still that team's, and a
 * suggestion list reads them perfectly well. The invariant here is that
 * nothing outside the caller's own teams reaches the prompt.
 *
 * The queries are asserted rather than the output, because the leak was in
 * what was fetched — by the time it is prose in a prompt it is already out.
 */
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import IssuesAIService from './issues-ai.service';

const USER = 'user-1';
const WORKSPACE = 'ws-1';
const MY_TEAM = 'team-mine';
const OTHER_TEAM = 'team-theirs';

function buildService(teamIds: string[] = [MY_TEAM]) {
  const prisma = {
    usersOnWorkspaces: {
      findUnique: jest.fn().mockResolvedValue({ teamIds }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    label: { findMany: jest.fn().mockResolvedValue([]) },
    workflow: { findMany: jest.fn().mockResolvedValue([]) },
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ id: WORKSPACE, name: 'Acme' }),
    },
  } as unknown as PrismaService;

  // Only the prisma client is reached before the queries under test; the model
  // call sits behind them and is never made here. The logger is the service's
  // own.
  const service = new IssuesAIService(prisma, null, null, null);

  return { service, prisma };
}

/** Runs aiFilters far enough to issue its queries, ignoring the model call. */
async function collect(
  service: IssuesAIService,
  teamId?: string,
  userId = USER,
) {
  try {
    await service.aiFilters(
      { text: 'my open bugs', workspaceId: WORKSPACE, teamId },
      userId,
    );
  } catch (error) {
    // The model call is not stubbed, so it throws once the material has been
    // gathered. Anything thrown *before* that is a real failure and is
    // re-raised.
    if (error instanceof NotFoundException) {
      throw error;
    }
  }
}

describe('IssuesAIService.aiFilters team scoping', () => {
  it('offers only the labels of teams the caller belongs to', async () => {
    const { service, prisma } = buildService([MY_TEAM]);
    await collect(service);

    expect(prisma.label.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: WORKSPACE,
        deleted: null,
        OR: [{ teamId: null }, { teamId: { in: [MY_TEAM] } }],
      },
    });
  });

  it('offers only the people of teams the caller belongs to', async () => {
    const { service, prisma } = buildService([MY_TEAM]);
    await collect(service);

    expect(prisma.usersOnWorkspaces.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, teamIds: { hasSome: [MY_TEAM] } },
      include: { user: true },
    });
  });

  it('offers only the workflows of teams the caller belongs to', async () => {
    const { service, prisma } = buildService([MY_TEAM]);
    await collect(service);

    expect(prisma.workflow.findMany).toHaveBeenCalledWith({
      where: {
        teamId: { in: [MY_TEAM] },
        team: { workspaceId: WORKSPACE },
        deleted: null,
      },
    });
  });

  it('refuses a team the caller does not belong to', async () => {
    // The team id arrives in the request body, so without this check the
    // boundary is whatever the caller typed.
    const { service } = buildService([MY_TEAM]);

    await expect(collect(service, OTHER_TEAM)).rejects.toThrow(NotFoundException);
  });

  it('narrows to the one named team when it is a visible one', async () => {
    const { service, prisma } = buildService([MY_TEAM, OTHER_TEAM]);
    await collect(service, MY_TEAM);

    expect(prisma.workflow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teamId: { in: [MY_TEAM] } }),
      }),
    );
  });

  it('offers nothing team-owned to a member of no team', async () => {
    // The correct answer rather than a fault: the membership says the person
    // joined no team. Workspace-wide labels still reach them.
    const { service, prisma } = buildService([]);
    await collect(service);

    expect(prisma.label.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: WORKSPACE,
        deleted: null,
        OR: [{ teamId: null }, { teamId: { in: [] } }],
      },
    });
    expect(prisma.workflow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teamId: { in: [] } }),
      }),
    );
  });
});
