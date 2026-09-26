import { ActionTypesEnum, RoleEnum } from '@vantikhq/types';

import { IntegrationEventsProcessor } from './integration-events.processor';

const ACCOUNT = {
  id: 'account-1',
  accountId: '12345',
  settings: { teamMappings: [{ source: 'repo-1', teamId: 'team-1' }] },
  workspaceId: 'workspace-1',
  integrationDefinition: {
    id: 'def-1',
    slug: 'github',
    name: 'GitHub',
    icon: 'github',
  },
  workspace: { id: 'workspace-1', slug: 'acme' },
};

function build(account: typeof ACCOUNT | null) {
  const prisma = {
    integrationAccount: { findFirst: jest.fn(async () => account) },
    user: { upsert: jest.fn(async () => ({ id: 'bot-1' })) },
    usersOnWorkspaces: {
      findUnique: jest.fn(async () => ({ role: RoleEnum.BOT })),
    },
  };
  const integrations = { loadIntegration: jest.fn(async () => 'done') };

  return {
    processor: new IntegrationEventsProcessor(
      prisma as never,
      integrations as never,
    ),
    prisma,
    integrations,
  };
}

const job = (payload: Record<string, unknown> = {}) =>
  ({
    data: {
      slug: 'github',
      workspaceId: 'workspace-1',
      integrationAccountId: 'account-1',
      event: ActionTypesEnum.ON_CREATE,
      payload: { type: 'Issue', modelId: 'issue-1', ...payload },
    },
  }) as never;

describe('running one event through a connected account', () => {
  it('hands the plugin its account, and writes as the integration bot', async () => {
    const { processor, integrations } = build(ACCOUNT);

    await processor.dispatch(job());

    expect(integrations.loadIntegration).toHaveBeenCalledWith('github', {
      type: 'Issue',
      modelId: 'issue-1',
      event: ActionTypesEnum.ON_CREATE,
      workspaceId: 'workspace-1',
      integrationAccountId: 'account-1',
      integrationAccount: ACCOUNT,
      userId: 'bot-1',
    });
  });

  it('reloads the account within the job’s workspace', async () => {
    const { processor, prisma } = build(ACCOUNT);

    await processor.dispatch(job());

    expect(prisma.integrationAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'account-1', workspaceId: 'workspace-1', deleted: null },
      }),
    );
  });

  it('never selects the account’s tokens', async () => {
    const { processor, prisma } = build(ACCOUNT);

    await processor.dispatch(job());

    const { select } = (
      prisma.integrationAccount.findFirst.mock.calls[0] as unknown as [
        { select: Record<string, unknown> },
      ]
    )[0];
    expect(select).not.toHaveProperty('integrationConfiguration');
  });

  it('does nothing for an account disconnected while the job waited', async () => {
    const { processor, integrations } = build(null);

    await expect(processor.dispatch(job())).resolves.toEqual({
      message: 'Account account-1 was disconnected',
    });
    expect(integrations.loadIntegration).not.toHaveBeenCalled();
  });

  it('lets no payload field stand in for the account or the author', async () => {
    const { processor, integrations } = build(ACCOUNT);

    await processor.dispatch(
      job({ userId: 'someone', integrationAccountId: 'other-account' }),
    );

    expect(integrations.loadIntegration).toHaveBeenCalledWith(
      'github',
      expect.objectContaining({
        userId: 'bot-1',
        integrationAccountId: 'account-1',
      }),
    );
  });
});
