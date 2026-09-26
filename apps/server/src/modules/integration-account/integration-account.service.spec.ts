import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { IntegrationAccountService } from './integration-account.service';

function buildService(
  row: Record<string, unknown> | null,
  {
    teamIds = ['team-own'],
    spec = { no_auth: { instruction: '' } } as unknown,
  } = {},
) {
  const prisma = {
    integrationAccount: {
      findFirst: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({ id: 'account-1' }),
      upsert: jest.fn().mockResolvedValue({ id: 'account-1' }),
    },
    integrationDefinitionV2: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'def-bug', slug: 'bug-enricher' }),
    },
    usersOnWorkspaces: {
      findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', teamIds }),
    },
  } as unknown as PrismaService;
  const integrations = { loadIntegration: jest.fn().mockResolvedValue(spec) };

  return {
    service: new IntegrationAccountService(prisma, integrations as never),
    prisma,
  };
}

describe('IntegrationAccountService.deleteIntegrationAccount', () => {
  it('disconnects a workspace account for any member', async () => {
    const { service, prisma } = buildService({
      personal: false,
      integratedById: 'someone-else',
    });

    await service.deleteIntegrationAccount(
      { integrationAccountId: 'account-1' },
      'user-1',
    );

    expect(prisma.integrationAccount.update).toHaveBeenCalled();
  });

  it('disconnects a personal account for the person who connected it', async () => {
    const { service, prisma } = buildService({
      personal: true,
      integratedById: 'user-1',
    });

    await service.deleteIntegrationAccount(
      { integrationAccountId: 'account-1' },
      'user-1',
    );

    expect(prisma.integrationAccount.update).toHaveBeenCalled();
  });

  it('refuses to disconnect a teammate-s personal account', async () => {
    const { service, prisma } = buildService({
      personal: true,
      integratedById: 'someone-else',
    });

    await expect(
      service.deleteIntegrationAccount(
        { integrationAccountId: 'account-1' },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.integrationAccount.update).not.toHaveBeenCalled();
  });

  it('refuses an account that is already gone', async () => {
    const { service, prisma } = buildService(null);

    await expect(
      service.deleteIntegrationAccount(
        { integrationAccountId: 'account-1' },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.integrationAccount.update).not.toHaveBeenCalled();
  });
});

describe('IntegrationAccountService.connect', () => {
  const dto = { integrationDefinitionId: 'def-bug', workspaceId: 'ws-1' };

  it('makes one workspace account, keyed by the workspace', async () => {
    const { service, prisma } = buildService(null);

    await service.connect(dto, 'user-1', 'ws-1');

    expect(prisma.integrationAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_integrationDefinitionId_workspaceId: {
            accountId: 'ws-1',
            integrationDefinitionId: 'def-bug',
            workspaceId: 'ws-1',
          },
        },
        create: expect.objectContaining({ personal: false }),
      }),
    );
  });

  it('refuses an integration that needs OAuth', async () => {
    // It would be an account with no credential for any vendor call to use.
    const { service, prisma } = buildService(null, {
      spec: { workspace_auth: {} },
    });

    await expect(service.connect(dto, 'user-1', 'ws-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.integrationAccount.upsert).not.toHaveBeenCalled();
  });

  it('never returns the account’s tokens', async () => {
    const { service, prisma } = buildService(null);

    await service.connect(dto, 'user-1', 'ws-1');

    const [{ select }] = (prisma.integrationAccount.upsert as jest.Mock).mock
      .calls[0];
    expect(select).not.toHaveProperty('integrationConfiguration');
  });
});

describe('IntegrationAccountService.updateTeamMappings', () => {
  const id = { integrationAccountId: 'account-1' };
  const workspaceAccount = (teamMappings: unknown[] = []) => ({
    personal: false,
    workspaceId: 'ws-1',
    settings: { repositories: [{ id: 'repo-1' }], teamMappings },
  });

  it('keeps the rest of the settings and drops duplicate pairs', async () => {
    const { service, prisma } = buildService(workspaceAccount());

    await service.updateTeamMappings(
      id,
      {
        teamMappings: [
          { source: 'repo-1', teamId: 'team-own' },
          { source: 'repo-1', teamId: 'team-own' },
        ],
      },
      'user-1',
    );

    expect(prisma.integrationAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          settings: {
            repositories: [{ id: 'repo-1' }],
            teamMappings: [{ source: 'repo-1', teamId: 'team-own' }],
          },
        },
      }),
    );
  });

  it('refuses to pair a team the caller is not in', async () => {
    // Pairing it with a repository would publish its issues there.
    const { service, prisma } = buildService(workspaceAccount());

    await expect(
      service.updateTeamMappings(
        id,
        { teamMappings: [{ source: 'repo-1', teamId: 'team-other' }] },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.integrationAccount.update).not.toHaveBeenCalled();
  });

  it('refuses to remove a pair for a team the caller is not in', async () => {
    const { service } = buildService(
      workspaceAccount([{ source: 'repo-1', teamId: 'team-other' }]),
    );

    await expect(
      service.updateTeamMappings(id, { teamMappings: [] }, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps a teammate’s pair it was handed back unchanged', async () => {
    const { service, prisma } = buildService(
      workspaceAccount([{ source: 'repo-1', teamId: 'team-other' }]),
    );

    await service.updateTeamMappings(
      id,
      {
        teamMappings: [
          { source: 'repo-1', teamId: 'team-other' },
          { source: 'repo-1', teamId: 'team-own' },
        ],
      },
      'user-1',
    );

    expect(prisma.integrationAccount.update).toHaveBeenCalled();
  });

  it('refuses a personal account, which routes nothing', async () => {
    const { service } = buildService({
      personal: true,
      workspaceId: 'ws-1',
      settings: {},
    });

    await expect(
      service.updateTeamMappings(id, { teamMappings: [] }, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
