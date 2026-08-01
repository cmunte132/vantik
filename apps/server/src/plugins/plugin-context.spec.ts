import { PluginContextFactory } from './plugin-context.factory';

/**
 * The context a plugin is handed.
 *
 * What is worth pinning is not that the calls forward — it is the two
 * properties that make the contract worth having: a plugin cannot reach past
 * the capabilities it is given, and a write goes through the service that owns
 * the model rather than straight to the database.
 *
 * The second is the one that would rot silently. Writing an issue through
 * Prisma here would be faster, would pass every test that only checks the row,
 * and would skip the sync engine, the notification queue and the history.
 */
describe('the plugin context', () => {
  const prisma = {
    integrationAccount: {
      findUnique: jest.fn().mockResolvedValue({ id: 'acc-1' }),
      findFirst: jest.fn().mockResolvedValue({ id: 'acc-2' }),
      upsert: jest.fn().mockResolvedValue({ id: 'acc-3' }),
      update: jest.fn().mockResolvedValue({ id: 'acc-1' }),
    },
    integrationDefinitionV2: {
      findFirst: jest.fn().mockResolvedValue({ id: 'def-1' }),
    },
    team: { findMany: jest.fn().mockResolvedValue([]) },
    label: { findMany: jest.fn().mockResolvedValue([]) },
    workflow: { findMany: jest.fn().mockResolvedValue([]) },
    usersOnWorkspaces: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const issuesService = {
    createIssueAPI: jest.fn().mockResolvedValue({ id: 'issue-1' }),
    updateIssueApi: jest.fn().mockResolvedValue({ id: 'issue-1' }),
    getIssueById: jest.fn().mockResolvedValue({ id: 'issue-1' }),
    getIssueByNumber: jest.fn().mockResolvedValue({ id: 'issue-1' }),
  };
  const commentsService = {
    createIssueComment: jest.fn().mockResolvedValue({ id: 'c-1' }),
    getLinkedCommentBySource: jest.fn().mockResolvedValue(null),
  };
  const linkedIssueService = {
    getLinkedIssueBySourceId: jest.fn().mockResolvedValue([]),
  };
  const aiService = { getLLMRequest: jest.fn().mockResolvedValue('answer') };

  function build(workspaceId = 'ws-1', userId = 'user-1') {
    return new PluginContextFactory(
      prisma as never,
      issuesService as never,
      commentsService as never,
      linkedIssueService as never,
      aiService as never,
    ).build('discord', workspaceId, userId);
  }

  /**
   * The property the whole design rests on. If a plugin can reach a database
   * client, no boundary drawn around it means anything — which is what every
   * integration did until this landed.
   */
  it('exposes capabilities and nothing that could reach the database', () => {
    const ctx = build();

    expect(Object.keys(ctx).sort()).toEqual([
      'account',
      'ai',
      'comments',
      'definitions',
      'issues',
      'links',
      'log',
      'workspace',
      'workspaceId',
    ]);

    for (const key of Object.keys(ctx)) {
      expect(key).not.toMatch(/prisma|db|client|connection/i);
    }
  });

  it('writes an issue through the service, not the database', async () => {
    const ctx = build();

    await ctx.issues.create('team-1', { title: 'From Discord' });

    expect(issuesService.createIssueAPI).toHaveBeenCalledWith(
      { title: 'From Discord', teamId: 'team-1' },
      'user-1',
    );
    // The row is never touched directly — that path skips the sync engine,
    // the notification queue and the issue history all at once.
    expect((prisma as never as { issue?: unknown }).issue).toBeUndefined();
  });

  it('acts as the user the caller named', async () => {
    const ctx = build('ws-1', 'workflow-user');

    await ctx.comments.create({ issueId: 'issue-1', bodyMarkdown: 'hi' });

    expect(commentsService.createIssueComment).toHaveBeenCalledWith(
      { issueId: 'issue-1' },
      'workflow-user',
      { issueId: 'issue-1', bodyMarkdown: 'hi' },
    );
  });

  /**
   * A plugin acts for one workspace. Scoping here rather than trusting the
   * plugin to pass the right id is the same reasoning the team-visibility work
   * applied to the routes.
   */
  it('scopes workspace reads to the workspace it was built for', async () => {
    const ctx = build('ws-42');

    await ctx.workspace.teams();
    await ctx.workspace.labels();

    expect(prisma.team.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-42' },
    });
    expect(prisma.label.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-42' },
    });
  });

  it('finds an account from a workspace slug, for inbound email', async () => {
    const ctx = build();

    await ctx.account.byWorkspaceSlug('email', 'acme');

    expect(prisma.integrationAccount.findFirst).toHaveBeenCalledWith({
      where: {
        deleted: null,
        workspace: { slug: 'acme' },
        integrationDefinition: { slug: 'email' },
      },
      include: { integrationDefinition: true },
    });
  });
});
