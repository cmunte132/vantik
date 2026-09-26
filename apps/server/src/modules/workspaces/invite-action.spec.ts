import { NotFoundException } from '@nestjs/common';
import { InviteStatusEnum, RoleEnum } from '@vantikhq/types';
import { Request, Response } from 'express';
import { SessionContainer } from 'supertokens-node/recipe/session';

import WorkspacesService from './workspaces.service';

// Answering an invite remints the session so it carries the new workspace;
// that is SuperTokens' work, not what is under test.
const createNewSession = jest.fn();
jest.mock('supertokens-node/recipe/session', () => ({
  __esModule: true,
  default: {},
  createNewSession: (...args: unknown[]) => createNewSession(...args),
}));

const INVITE = {
  id: 'invite-1',
  emailId: 'invited@example.com',
  workspaceId: 'workspace-1',
  teamIds: ['team-1'],
  role: RoleEnum.ADMIN,
  status: InviteStatusEnum.INVITED,
  deleted: null as Date | null,
};

function sessionOf(userId: string) {
  return {
    getAccessTokenPayload: () => ({ appUserId: userId }),
    getRecipeUserId: () => `recipe-${userId}`,
  } as unknown as SessionContainer;
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
  };
  let invite: typeof INVITE;

  beforeEach(() => {
    invite = { ...INVITE };
    createNewSession.mockReset();

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
    };

    service = new WorkspacesService(prisma as never, {} as never, {} as never);
  });

  it('joins the person it was sent to to the workspace', async () => {
    const res = response();

    await service.inviteAction(
      {} as Request,
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
  });

  it('refuses anyone else, and leaves the invite open', async () => {
    // Anyone signed in used to be able to accept by id, and join the
    // workspace in the role the invite carried.
    await expect(
      service.inviteAction(
        {} as Request,
        response(),
        INVITE.id,
        sessionOf('user-else'),
        true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.usersOnWorkspaces.upsert).not.toHaveBeenCalled();
    expect(prisma.invite.update).not.toHaveBeenCalled();
    expect(createNewSession).not.toHaveBeenCalled();
  });

  it('refuses an invite already declined', async () => {
    await service.inviteAction(
      {} as Request,
      response(),
      INVITE.id,
      sessionOf('user-invited'),
      false,
    );
    expect(invite.status).toBe(InviteStatusEnum.DECLINED);

    await expect(
      service.inviteAction(
        {} as Request,
        response(),
        INVITE.id,
        sessionOf('user-invited'),
        true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.usersOnWorkspaces.upsert).not.toHaveBeenCalled();
  });
});
