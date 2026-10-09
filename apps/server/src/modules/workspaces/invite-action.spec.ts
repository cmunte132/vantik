import { NotFoundException } from '@nestjs/common';
import { InviteStatusEnum, RoleEnum } from '@vantikhq/types';
import { Response } from 'express';
import { AuthSessionContext } from 'modules/auth/auth.interface';
import { AuthService } from 'modules/auth/auth.service';
import WorkspacesService from './workspaces.service';

const INVITE = {
  id: 'invite-1',
  emailId: 'invited@example.com',
  workspaceId: 'workspace-1',
  teamIds: ['team-1'],
  role: RoleEnum.ADMIN,
  status: InviteStatusEnum.INVITED,
  deleted: null as Date | null,
};

function sessionOf(userId: string): AuthSessionContext {
  return {
    getAccessTokenPayload: () => ({
      appUserId: userId,
      sessionId: `session-of-${userId}`,
    }),
    getUserId: () => userId,
  };
}

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & typeof res;
}

describe('answering an invite', () => {
  let service: WorkspacesService;
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock };
    invite: { findFirst: jest.Mock; update: jest.Mock };
    usersOnWorkspaces: { upsert: jest.Mock };
    team: { findMany: jest.Mock };
  };
  let authService: { updateSessionWorkspace: jest.Mock };
  let invite: typeof INVITE;
  beforeEach(() => {
    invite = { ...INVITE };
    authService = { updateSessionWorkspace: jest.fn().mockResolvedValue(undefined) };

    const emails: Record<string, string> = {
      'user-invited': INVITE.emailId,
      'user-else': 'someone.else@example.com',
    };

    prisma = {
      user: {
        findUniqueOrThrow: jest.fn(async ({ where }) => ({
          email: emails[where.id],
        })),
      },
      invite: {
        // The one invite, found only by the filter the service asks with.
        findFirst: jest.fn(async ({ where }) =>
          where.id === invite.id &&
          where.emailId === invite.emailId &&
          (where.deleted === null ? invite.deleted === null : true)
            ? invite
            : null,
        ),
        update: jest.fn(async ({ data }) => {
          invite = { ...invite, ...data };
          return invite;
        }),
      },
      usersOnWorkspaces: { upsert: jest.fn().mockResolvedValue({}) },
      team: {
        // Only team-1 is a live team of the invite's workspace.
        findMany: jest.fn(async ({ where }) =>
          where.workspaceId === INVITE.workspaceId
            ? where.id.in
                .filter((id: string) => id === 'team-1')
                .map((id: string) => ({ id }))
            : [],
        ),
      },
    };

    service = new WorkspacesService(prisma as never, {} as never, {} as never, authService as unknown as AuthService);
  });

  it('joins the person it was sent to to the workspace', async () => {
    const res = response();

    await service.inviteAction(
      res,
      INVITE.id,
      sessionOf('user-invited'),
      true,
    );

    expect(prisma.usersOnWorkspaces.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId: INVITE.workspaceId,
          userId: 'user-invited',
          role: RoleEnum.ADMIN,
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    // Only the session that accepted moves to the workspace, and it keeps its
    // token.
    expect(authService.updateSessionWorkspace).toHaveBeenCalledWith(
      'session-of-user-invited',
      INVITE.workspaceId,
      RoleEnum.ADMIN,
    );
  });

  it('keeps only the teams of the invite workspace when it joins the person', async () => {
    // An invite written before invites were checked can hold a foreign id.
    invite = { ...invite, teamIds: ['team-1', 'team-of-another-workspace'] };

    await service.inviteAction(
      response(),
      INVITE.id,
      sessionOf('user-invited'),
      true,
    );

    expect(prisma.usersOnWorkspaces.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ teamIds: ['team-1'] }),
      }),
    );
  });

  it('refuses anyone else, and leaves the invite open', async () => {
    // Anyone signed in used to be able to accept by id, and join the
    // workspace in the role the invite carried.
    await expect(
      service.inviteAction(
          response(),
        INVITE.id,
        sessionOf('user-else'),
        true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.usersOnWorkspaces.upsert).not.toHaveBeenCalled();
    expect(prisma.invite.update).not.toHaveBeenCalled();
    expect(authService.updateSessionWorkspace).not.toHaveBeenCalled();
  });

  it('refuses an invite already declined', async () => {
    await service.inviteAction(
      response(),
      INVITE.id,
      sessionOf('user-invited'),
      false,
    );
    expect(invite.status).toBe(InviteStatusEnum.DECLINED);

    await expect(
      service.inviteAction(
          response(),
        INVITE.id,
        sessionOf('user-invited'),
        true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.usersOnWorkspaces.upsert).not.toHaveBeenCalled();
  });
});
