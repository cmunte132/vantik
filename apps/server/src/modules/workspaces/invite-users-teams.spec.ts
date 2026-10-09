/**
 * `POST /v1/workspaces/invite_users` wrote the team ids of the body into the
 * invite as sent, and accepting the invite copied them into the membership. An
 * admin of one workspace could so plant a team of another. Each id must be a
 * live team of the workspace, and the check comes before the invite is written.
 */
import { NotFoundException } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';

import WorkspacesService from './workspaces.service';

const WORKSPACE = 'workspace-1';

function buildService() {
  const workspace = { id: WORKSPACE, name: 'Acme' };
  const prisma = {
    team: {
      // Only team-1 is a live team of the workspace.
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; workspaceId: string } }) =>
          where.id === 'team-1' && where.workspaceId === WORKSPACE
            ? { id: 'team-1' }
            : null,
      ),
    },
    workspace: {
      findUnique: jest.fn().mockResolvedValue(workspace),
      findUniqueOrThrow: jest.fn().mockResolvedValue(workspace),
    },
    invite: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const usersService = {
    getUser: jest.fn().mockResolvedValue({ fullname: 'Admin' }),
  };
  const authService = {
    createInviteMagicLink: jest.fn().mockResolvedValue('https://link'),
  };
  const mailer = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const service = new WorkspacesService(
    prisma as never,
    mailer as never,
    usersService as never,
    authService as never,
  );

  return { service, prisma, mailer };
}

const session = {
  getAccessTokenPayload: () => ({ appUserId: 'admin-1' }),
  getUserId: () => 'admin-1',
};

describe('WorkspacesService.inviteUsers team ids', () => {
  it('refuses a team of another workspace and writes no invite', async () => {
    const { service, prisma, mailer } = buildService();

    await expect(
      service.inviteUsers(session as never, WORKSPACE, {
        emailIds: 'new@example.com',
        teamIds: ['team-1', 'team-of-another-workspace'],
        role: RoleEnum.USER,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.invite.upsert).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('writes the invite when every team is in the workspace', async () => {
    const { service, prisma } = buildService();

    await service.inviteUsers(session as never, WORKSPACE, {
      emailIds: 'new@example.com',
      teamIds: ['team-1'],
      role: RoleEnum.USER,
    });

    expect(prisma.invite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ teamIds: ['team-1'] }),
      }),
    );
  });
});
