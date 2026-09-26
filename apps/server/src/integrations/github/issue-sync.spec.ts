import { ActionTypesEnum, ModelNameEnum, RoleEnum } from '@vantikhq/types';

import { issueSync } from './issue-sync';

import run from './index';

const ISSUE = {
  id: 'issue-1',
  teamId: 'team-1',
  title: 'The printer is on fire',
  createdById: 'user-1',
  stateId: 'state-1',
  labelIds: [] as string[],
  team: { workspaceId: 'workspace-1' },
};

function contextFor(author = { userId: 'user-1', role: RoleEnum.USER }) {
  const fetch = jest.fn(async () => ({
    ok: true,
    status: 201,
    json: async () => ({
      id: 99,
      number: 7,
      title: ISSUE.title,
      url: 'https://api.github.com/repos/acme/app/issues/7',
      html_url: 'https://github.com/acme/app/issues/7',
      comments_url: 'https://api.github.com/repos/acme/app/issues/7/comments',
      user: { login: 'vantik-bot[bot]' },
    }),
  }));

  const ctx = {
    log: { debug: jest.fn(), error: jest.fn(), info: jest.fn() },
    issues: {
      get: jest.fn(async () => ISSUE),
      update: jest.fn(async () => ISSUE),
    },
    workspace: {
      users: jest.fn(async () => [author]),
      workflows: jest.fn(async () => [{ id: 'state-1', category: 'TODO' }]),
      labels: jest.fn(async (): Promise<unknown[]> => []),
    },
    account: { personal: jest.fn(async (): Promise<unknown> => null) },
    vendor: { fetch },
  };

  return { ctx, fetch };
}

function payloadFor(teamMappings: unknown[]) {
  return {
    modelId: 'issue-1',
    userId: 'bot-1',
    integrationAccount: {
      id: 'account-1',
      integrationDefinition: { slug: 'github' },
      settings: {
        repositories: [{ id: 'repo-1', fullName: 'acme/app' }],
        teamMappings,
      },
    },
  };
}

describe('a Vantik issue pushed out to GitHub', () => {
  it('opens it in the repository its team is paired with', async () => {
    const { ctx, fetch } = contextFor();

    await issueSync(
      ctx as never,
      payloadFor([{ source: 'repo-1', teamId: 'team-1' }]),
    );

    expect(fetch).toHaveBeenCalledWith(
      '/repos/acme/app/issues',
      expect.objectContaining({ method: 'POST', as: 'bot' }),
    );
    // The link is written as the integration's bot, which is what stops the
    // update it causes from being pushed straight back out.
    expect(ctx.issues.update).toHaveBeenCalledWith(
      'issue-1',
      'team-1',
      expect.objectContaining({
        linkIssueData: expect.objectContaining({ createdById: 'bot-1' }),
      }),
    );
  });

  it('leaves an issue of an unpaired team in Vantik', async () => {
    const { ctx, fetch } = contextFor();

    await issueSync(
      ctx as never,
      payloadFor([{ source: 'repo-1', teamId: 'team-2' }]),
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens nothing when the paired repository left the installation', async () => {
    const { ctx, fetch } = contextFor();

    await expect(
      issueSync(
        ctx as never,
        payloadFor([{ source: 'repo-gone', teamId: 'team-1' }]),
      ),
    ).resolves.toEqual({
      message: 'Repository repo-gone is no longer installed',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores an issue a bot wrote', async () => {
    const { ctx, fetch } = contextFor({ userId: 'user-1', role: RoleEnum.BOT });

    await issueSync(
      ctx as never,
      payloadFor([{ source: 'repo-1', teamId: 'team-1' }]),
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it('is what a new issue is routed to', async () => {
    const { ctx, fetch } = contextFor();

    await run(
      {
        ...payloadFor([{ source: 'repo-1', teamId: 'team-1' }]),
        event: ActionTypesEnum.ON_CREATE as never,
        type: ModelNameEnum.Issue,
      },
      ctx as never,
    );

    expect(fetch).toHaveBeenCalledWith(
      '/repos/acme/app/issues',
      expect.anything(),
    );
  });
});
