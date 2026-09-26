import { RoleEnum, UserTypeEnum } from '@vantikhq/types';

import { ensureIntegrationBot } from './integration-bot';

const GITHUB = { slug: 'github', name: 'GitHub', icon: 'github' };

function build(member: { role: string } | null) {
  return {
    user: { upsert: jest.fn(async () => ({ id: 'bot-1' })) },
    usersOnWorkspaces: {
      findUnique: jest.fn(async () => member),
      upsert: jest.fn(async () => ({})),
    },
    team: {
      findMany: jest.fn(async () => [{ id: 'team-1' }, { id: 'team-2' }]),
    },
  };
}

describe('the member a connected integration writes as', () => {
  it('keeps the address a deployed Action used, so the author does not change', async () => {
    const prisma = build({ role: RoleEnum.BOT });

    await ensureIntegrationBot(prisma as never, 'workspace-1', GITHUB);

    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'github_workspace-1@vantik.dev' },
        create: expect.objectContaining({
          fullname: 'GitHub',
          image: 'github',
          type: UserTypeEnum.System,
        }),
      }),
    );
  });

  it('joins a new bot to every team as a BOT', async () => {
    // The role is what the GitHub sync reads to avoid mirroring its own writes.
    const prisma = build(null);

    await expect(
      ensureIntegrationBot(prisma as never, 'workspace-1', GITHUB),
    ).resolves.toBe('bot-1');

    expect(prisma.usersOnWorkspaces.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          userId: 'bot-1',
          workspaceId: 'workspace-1',
          role: RoleEnum.BOT,
          teamIds: ['team-1', 'team-2'],
        },
      }),
    );
  });

  it('leaves an existing bot’s teams alone', async () => {
    const prisma = build({ role: RoleEnum.BOT });

    await ensureIntegrationBot(prisma as never, 'workspace-1', GITHUB);

    expect(prisma.usersOnWorkspaces.upsert).not.toHaveBeenCalled();
    expect(prisma.team.findMany).not.toHaveBeenCalled();
  });
});
