import { InternalServerErrorException } from '@nestjs/common';
import {
  AgentOwnership,
  DEFAULT_AGENT_SCOPES,
  RoleEnum,
  UserTypeEnum,
} from '@vantikhq/types';

import { UsersService } from './users.service';

// The agent credential is minted through SuperTokens; stub it so the test
// exercises our orchestration, not the recipe.
const signInUp = jest.fn();
jest.mock('supertokens-node/recipe/passwordless', () => ({
  __esModule: true,
  default: {
    signInUp: (...args: unknown[]) => signInUp(...args),
  },
}));

// createPersonalAccessToken generates the token string here; stub it so the
// test asserts on a known value.
jest.mock('common/authentication', () => ({
  generatePersonalAccessToken: jest.fn().mockReturnValue('tg_pat_agentSECRET'),
}));

function buildPrisma() {
  const prisma = {
    // Provisioning writes inside a transaction so a half-made agent cannot be
    // left behind; the stub just runs the callback against the same mock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: (fn: any) => fn(prisma),
    // Every agent route resolves the workspace and proves the caller
    // administers *that* one, rather than trusting the access token's.
    usersOnWorkspaces: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: 'ACTIVE', role: RoleEnum.ADMIN }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    user: {
      upsert: jest.fn().mockResolvedValue({
        id: 'agent-user-1',
        email: 'x',
      }),
      update: jest.fn().mockResolvedValue({
        id: 'agent-user-1',
        fullname: 'Release Bot',
      }),
    },
    authIdentity: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    team: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'team-1' }, { id: 'team-2' }]),
    },
    personalAccessToken: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'pat-1', token: 'tg_pat_agentSECRET' }),
    },
  };

  return prisma;
}

/** The service over a stubbed prisma; each suite supplies the shape it needs. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function serviceWith(prisma: any) {
  return new UsersService(prisma, {} as any);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('UsersService.createAgentAccount', () => {
  let prisma: ReturnType<typeof buildPrisma>;

  /** Provisions the agent every test here provisions; only the name varies. */
  function provision(name = 'Release Bot', ownership?: AgentOwnership) {
    return serviceWith(prisma).createAgentAccount(
      'ws-1',
      name,
      'admin-1',
      ownership,
    );
  }

  beforeEach(() => {
    prisma = buildPrisma();
    signInUp.mockReset();
    signInUp.mockResolvedValue({
      status: 'OK',
      recipeUserId: { getAsString: () => 'st-recipe-1' },
    });
  });

  it('gives the agent a passwordless credential at a synthetic address', async () => {
    await provision();

    expect(signInUp).toHaveBeenCalledTimes(1);
    const arg = signInUp.mock.calls[0][0];
    expect(arg.tenantId).toBe('public');
    expect(arg.email).toMatch(
      /^agent-release-bot-[0-9a-f]{8}@agents\.vantik\.local$/,
    );
  });

  it('records the credential against a new account', async () => {
    await provision();

    expect(prisma.authIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'agent-user-1',
          provider: 'passwordless',
          supertokensUserId: 'st-recipe-1',
        }),
      }),
    );
  });

  it('sets the display name so the agent reads as itself', async () => {
    await provision();

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { fullname: 'Release Bot', type: UserTypeEnum.Agent },
      }),
    );
  });

  it('joins the agent to the workspace as an AGENT across its teams', async () => {
    await provision();

    expect(prisma.usersOnWorkspaces.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'agent-user-1',
          workspaceId: 'ws-1',
          role: RoleEnum.AGENT,
          teamIds: ['team-1', 'team-2'],
        }),
      }),
    );
  });

  it('records the agent as personal and owned by its creator', async () => {
    const result = await provision();

    expect(prisma.usersOnWorkspaces.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          settings: {
            agent: {
              ownership: 'personal',
              ownerUserId: 'admin-1',
              scopes: DEFAULT_AGENT_SCOPES,
            },
          },
        }),
      }),
    );
    expect(result.ownership).toBe('personal');
    expect(result.ownerUserId).toBe('admin-1');
  });

  it('leaves a workspace-owned agent without an owning user', async () => {
    const result = await provision('House Agent', 'workspace');

    expect(prisma.usersOnWorkspaces.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          settings: {
            agent: {
              ownership: 'workspace',
              ownerUserId: null,
              scopes: DEFAULT_AGENT_SCOPES,
            },
          },
        }),
      }),
    );
    expect(result.ownerUserId).toBeNull();
  });

  it('issues an agent-typed PAT and returns it once', async () => {
    const result = await provision();

    expect(prisma.personalAccessToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'agent-user-1',
          workspaceId: 'ws-1',
          type: 'agent',
        }),
      }),
    );
    expect(result).toEqual({
      id: 'agent-user-1',
      name: 'Release Bot',
      email: expect.stringMatching(/@agents\.vantik\.local$/),
      ownership: 'personal',
      ownerUserId: 'admin-1',
      scopes: DEFAULT_AGENT_SCOPES,
      token: 'tg_pat_agentSECRET',
      // Minted a moment ago and used for nothing yet. Null rather than absent,
      // because "never used" is how the settings list flags a leftover and it
      // has to be true from the start.
      lastUsedAt: null,
    });
  });

  it('does not create an account if the credential could not be minted', async () => {
    signInUp.mockResolvedValue({ status: 'SIGN_IN_UP_NOT_ALLOWED' });

    await expect(provision()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
  });
});

describe('UsersService.listAgentAccounts', () => {
  const membership = {
    userId: 'agent-1',
    joinedAt: new Date('2026-07-01T00:00:00.000Z'),
    settings: { agent: { ownership: 'personal', ownerUserId: 'admin-1' } },
    user: {
      id: 'agent-1',
      fullname: 'Release Bot',
      email: 'agent-release-bot-abcd1234@agents.vantik.local',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    },
  };

  function listPrisma(
    activeTokenUserIds: string[],
    extraTokens: Array<{
      userId: string;
      deleted: Date | null;
      lastUsedAt: Date | null;
    }> = [],
  ) {
    return {
      usersOnWorkspaces: {
        findMany: jest.fn().mockResolvedValue([membership]),
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', role: RoleEnum.ADMIN }),
      },
      personalAccessToken: {
        // Every token, live or revoked: the listing reads `lastUsedAt` off the
        // revoked ones too, and decides `active` in application code.
        findMany: jest.fn().mockResolvedValue([
          ...activeTokenUserIds.map(
            (userId): { userId: string; deleted: Date | null; lastUsedAt: Date | null } => ({
              userId,
              deleted: null,
              lastUsedAt: null,
            }),
          ),
          ...extraTokens,
        ]),
      },
    };
  }

  it('reads ownership from the membership and marks a live token active', async () => {
    const prisma = listPrisma(['agent-1']);
    const [agent] = await serviceWith(prisma).listAgentAccounts(
      'ws-1',
      'admin-1',
    );

    expect(prisma.usersOnWorkspaces.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws-1', role: RoleEnum.AGENT },
      }),
    );
    expect(agent).toMatchObject({
      id: 'agent-1',
      name: 'Release Bot',
      ownership: 'personal',
      ownerUserId: 'admin-1',
      active: true,
    });
  });

  it('marks an agent with no live token inactive', async () => {
    const prisma = listPrisma([]);
    const [agent] = await serviceWith(prisma).listAgentAccounts(
      'ws-1',
      'admin-1',
    );

    expect(agent.active).toBe(false);
  });

  it('only looks at agent-typed tokens in this workspace', async () => {
    const prisma = listPrisma(['agent-1']);
    await serviceWith(prisma).listAgentAccounts('ws-1', 'admin-1');

    expect(prisma.personalAccessToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: 'ws-1', type: 'agent' }),
      }),
    );
  });

  it('does not let a revoked token make an agent active', async () => {
    // Deleted rows are fetched on purpose — they still carry a last-used time
    // worth reporting — so `active` has to be decided on `deleted`, not on the
    // row merely existing.
    const prisma = listPrisma([], [
      { userId: 'agent-1', deleted: new Date(), lastUsedAt: new Date() },
    ]);
    const [agent] = await serviceWith(prisma).listAgentAccounts(
      'ws-1',
      'admin-1',
    );

    expect(agent.active).toBe(false);
  });

  it('reports an agent that has never authenticated as never used', async () => {
    const prisma = listPrisma(['agent-1']);
    const [agent] = await serviceWith(prisma).listAgentAccounts(
      'ws-1',
      'admin-1',
    );

    expect(agent.lastUsedAt).toBeNull();
  });

  it('reports the most recent use across an agent’s tokens', async () => {
    const older = new Date('2026-07-01T00:00:00.000Z');
    const newer = new Date('2026-07-20T00:00:00.000Z');

    // An agent can hold more than one token over its life — a rotation leaves
    // the old one deleted — so its last use is the newest of all of them.
    const prisma = listPrisma([], [
      { userId: 'agent-1', deleted: new Date(), lastUsedAt: older },
      { userId: 'agent-1', deleted: null, lastUsedAt: newer },
    ]);
    const [agent] = await serviceWith(prisma).listAgentAccounts(
      'ws-1',
      'admin-1',
    );

    expect(agent.lastUsedAt).toBe(newer.toISOString());
    expect(agent.active).toBe(true);
  });
});

describe('UsersService.revokeAgent', () => {
  function revokePrisma(found: boolean) {
    return {
      usersOnWorkspaces: {
        findFirst: jest
          .fn()
          .mockResolvedValue(found ? { userId: 'agent-1' } : null),
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: 'ACTIVE', role: RoleEnum.ADMIN }),
      },
      personalAccessToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
  }

  it("soft-deletes only this workspace's agent tokens for the account", async () => {
    const prisma = revokePrisma(true);
    await serviceWith(prisma).revokeAgent('ws-1', 'agent-1', 'admin-1');

    expect(prisma.personalAccessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: 'ws-1',
          userId: 'agent-1',
          type: 'agent',
          deleted: null,
        },
        data: expect.objectContaining({ deleted: expect.any(Date) }),
      }),
    );
  });

  it('refuses to revoke something that is not an agent here', async () => {
    const prisma = revokePrisma(false);

    await expect(
      serviceWith(prisma).revokeAgent('ws-1', 'not-an-agent', 'admin-1'),
    ).rejects.toThrow(/No agent/);
    expect(prisma.personalAccessToken.updateMany).not.toHaveBeenCalled();
  });
});
