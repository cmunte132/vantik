/**
 * The context pack: what every executor is handed, identically.
 *
 * Snapshot-tested because the pack's *shape* is the contract. A field quietly
 * disappearing is not a crash anywhere — the agent simply stops being told
 * something, produces slightly worse work, and nothing fails. The snapshot is
 * the only thing that notices.
 */
import { PrismaService } from 'nestjs-prisma';

import type { IssueContext } from 'modules/issues/issue-context.interface';
import type IssueContextService from 'modules/issues/issue-context.service';
import type { LocalRepoService } from 'modules/local-repo/local-repo.service';

import { ContextPackService } from './context-pack.service';

const WORKSPACE = 'workspace-1';

const issueContext = {
  id: 'issue-1',
  key: 'ENG-42',
  title: 'Search returns deleted issues',
  descriptionMarkdown:
    '## What\n\nThe filter endpoint omits `deleted: null`, so soft-deleted\nissues come back in results.',
  state: { id: 'state-1', name: 'In Progress', category: 'STARTED' },
  assignee: { id: 'user-1', fullname: 'Ada Lovelace' },
  team: { id: 'team-1', identifier: 'ENG', name: 'Engineering' },
  labels: [{ id: 'label-1', name: 'bug' }],
  priority: 2,
  estimate: null,
  dueDate: null,
  project: { id: 'project-1', name: 'Search rewrite' },
  cycle: null,
  parent: null,
  subIssues: [
    { id: 'issue-2', key: 'ENG-43', title: 'Add the regression test', stateCategory: 'COMPLETED' },
    { id: 'issue-3', key: 'ENG-44', title: 'Backfill the index', stateCategory: 'BACKLOG' },
  ],
  relations: [
    { type: 'BLOCKS', issue: { id: 'issue-9', key: 'ENG-50', title: 'Ship search v2' } },
  ],
  linkedIssues: [{ url: 'https://example.test/pr/1', title: 'Earlier attempt' }],
  criteria: [
    { id: 'c1', body: 'Deleted issues never appear in filter results', completed: false },
    { id: 'c2', body: 'A regression test covers the soft-delete case', completed: true },
  ],
  comments: [
    {
      id: 'comment-1',
      author: { id: 'user-2', fullname: 'Grace Hopper' },
      createdAt: new Date('2026-07-20T09:00:00.000Z'),
      updatedAt: new Date('2026-07-20T09:00:00.000Z'),
      bodyMarkdown: 'Reproduced on staging.',
    },
  ],
  history: [],
  createdAt: new Date('2026-07-19T09:00:00.000Z'),
  updatedAt: new Date('2026-07-20T09:00:00.000Z'),
} as unknown as IssueContext;

interface Routing {
  /** The modules the issue names. */
  moduleIds?: string[];
  /** The `ModuleRepo` rows those modules hold. */
  moduleRepos?: Array<{
    externalRepoId: string;
    fullName: string;
    integrationAccountId: string | null;
    pathPrefixes: string[];
  }>;
  /** Catalogue slug of the integration those repositories came from. */
  slug?: string | null;
  /** What `LocalRepoService.pathOf` answers. */
  localPath?: string | null;
  /** The verification blob each of those modules carries. */
  moduleVerification?: Array<{ verification: unknown }>;
}

function buildService(preferences: unknown = null, routing: Routing = {}) {
  const prisma = {
    workspace: {
      findUnique: jest.fn(() => Promise.resolve({ preferences })),
    },
    issue: {
      findUnique: jest.fn(() =>
        Promise.resolve({ moduleIds: routing.moduleIds ?? [] }),
      ),
    },
    moduleRepo: {
      findMany: jest.fn(() => Promise.resolve(routing.moduleRepos ?? [])),
    },
    module: {
      findMany: jest.fn(() =>
        Promise.resolve(routing.moduleVerification ?? []),
      ),
    },
    integrationAccount: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          integrationDefinition: { slug: routing.slug ?? null },
        }),
      ),
    },
  } as unknown as PrismaService;

  const context = {
    getIssueContext: jest.fn(() => Promise.resolve(issueContext)),
  } as unknown as IssueContextService;

  const localRepo = {
    pathOf: jest.fn(() => Promise.resolve(routing.localPath ?? null)),
  } as unknown as LocalRepoService;

  return new ContextPackService(prisma, context, localRepo);
}

describe('ContextPackService', () => {
  const originalHost = process.env.FRONTEND_HOST;

  beforeAll(() => {
    process.env.FRONTEND_HOST = 'https://vantik.test';
  });

  afterAll(() => {
    process.env.FRONTEND_HOST = originalHost;
  });

  it('hands every executor the same pack', async () => {
    const service = buildService({
      agentRuns: {
        repo: {
          repoUrl: 'git@example.test:acme/app.git',
          baseBranch: 'main',
          setupCommands: ['pnpm install --frozen-lockfile'],
          testCommand: 'pnpm test',
          lintCommand: 'pnpm lint',
          typecheckCommand: 'pnpm typecheck',
        },
      },
    });

    await expect(service.build('issue-1', WORKSPACE)).resolves
      .toMatchInlineSnapshot(`
{
  "comments": [
    {
      "at": "2026-07-20T09:00:00.000Z",
      "author": "Grace Hopper",
      "body": "Reproduced on staging.",
    },
  ],
  "definitionOfDone": [
    {
      "body": "Deleted issues never appear in filter results",
      "completed": false,
      "id": "c1",
    },
    {
      "body": "A regression test covers the soft-delete case",
      "completed": true,
      "id": "c2",
    },
  ],
  "issue": {
    "description": "## What

The filter endpoint omits \`deleted: null\`, so soft-deleted
issues come back in results.",
    "id": "issue-1",
    "key": "ENG-42",
    "labels": [
      "bug",
    ],
    "priority": "high",
    "project": {
      "id": "project-1",
      "name": "Search rewrite",
    },
    "state": "In Progress",
    "stateCategory": "STARTED",
    "team": {
      "id": "team-1",
      "identifier": "ENG",
      "name": "Engineering",
    },
    "title": "Search returns deleted issues",
    "url": "https://vantik.test/issue/ENG-42",
  },
  "knowledge": [],
  "links": [
    {
      "title": "Earlier attempt",
      "url": "https://example.test/pr/1",
    },
  ],
  "relations": [
    {
      "key": "ENG-50",
      "title": "Ship search v2",
      "type": "BLOCKS",
    },
  ],
  "repo": {
    "baseBranch": "main",
    "delivery": "pull_request",
    "lintCommand": "pnpm lint",
    "repoUrl": "git@example.test:acme/app.git",
    "setupCommands": [
      "pnpm install --frozen-lockfile",
    ],
    "testCommand": "pnpm test",
    "typecheckCommand": "pnpm typecheck",
  },
  "subTasks": [
    {
      "done": true,
      "key": "ENG-43",
      "title": "Add the regression test",
    },
    {
      "done": false,
      "key": "ENG-44",
      "title": "Backfill the index",
    },
  ],
  "version": 1,
}
`);
  });

  it('carries guidance as its own field, beside the Definition of Done', async () => {
    const service = buildService({});

    const pack = await service.build(
      'issue-1',
      WORKSPACE,
      undefined,
      'Follow the spec style in this folder. Do not touch the migration.',
    );

    // Its own field on purpose. A criterion is what the work is judged
    // against, the description is the problem, and this is how the person
    // wants it approached — folding it into either would also make the pack
    // lie about what the issue says.
    expect(pack.guidance).toBe(
      'Follow the spec style in this folder. Do not touch the migration.',
    );
    expect(pack.issue.description).not.toContain('migration');
  });

  it('leaves guidance out entirely rather than carrying a blank one', async () => {
    const service = buildService({});

    // A blank string becomes a blank heading in the prompt, which reads to a
    // model as an instruction it failed to receive.
    expect((await service.build('issue-1', WORKSPACE, undefined, '   ')).guidance)
      .toBeUndefined();
    expect((await service.build('issue-1', WORKSPACE)).guidance).toBeUndefined();
  });

  it('carries the repo’s verification commands, not just its address', async () => {
    const service = buildService({
      agentRuns: {
        repo: { repoUrl: 'git@example.test:acme/app.git', testCommand: 'pnpm test' },
      },
    });

    const pack = await service.build('issue-1', WORKSPACE);

    // The single highest-leverage field in the pack. Without it every runner
    // re-derives the commands by guessing, and "the agent could not run
    // anything" is the most common failure these systems have.
    expect(pack.repo.testCommand).toBe('pnpm test');
  });

  it('delivers a worktree when the workspace has no remote', async () => {
    const service = buildService({
      agentRuns: { repo: { repoPath: '/srv/app' } },
    });

    const pack = await service.build('issue-1', WORKSPACE);

    // Derived, not configured: a local-only install needs no setup at all to
    // get something reviewable back.
    expect(pack.repo.delivery).toBe('worktree');
  });

  it('delivers a pull request when there is somewhere to push', async () => {
    const service = buildService({
      agentRuns: { repo: { repoUrl: 'git@example.test:acme/app.git' } },
    });

    await expect(service.build('issue-1', WORKSPACE)).resolves.toMatchObject({
      repo: { delivery: 'pull_request' },
    });
  });

  it('lets the delegating caller override the workspace default', async () => {
    const service = buildService({
      agentRuns: {
        repo: { repoUrl: 'git@example.test:acme/app.git', baseBranch: 'main' },
      },
    });

    const pack = await service.build('issue-1', WORKSPACE, {
      baseBranch: 'release/2026-07',
      delivery: 'worktree',
    });

    expect(pack.repo).toMatchObject({
      baseBranch: 'release/2026-07',
      delivery: 'worktree',
      // Untouched fields survive the override rather than being blanked.
      repoUrl: 'git@example.test:acme/app.git',
    });
  });

  it('does not let an absent override blank out a default', async () => {
    const service = buildService({
      agentRuns: { repo: { baseBranch: 'main', testCommand: 'pnpm test' } },
    });

    const pack = await service.build('issue-1', WORKSPACE, {
      baseBranch: undefined,
      testCommand: undefined,
    });

    expect(pack.repo).toMatchObject({
      baseBranch: 'main',
      testCommand: 'pnpm test',
    });
  });

  it('survives a workspace with no agent configuration at all', async () => {
    const service = buildService(null);

    await expect(service.build('issue-1', WORKSPACE)).resolves.toMatchObject({
      repo: { delivery: 'worktree' },
    });
  });

  it('omits the issue url rather than inventing a host', async () => {
    delete process.env.FRONTEND_HOST;
    const service = buildService();

    const pack = await service.build('issue-1', WORKSPACE);
    process.env.FRONTEND_HOST = 'https://vantik.test';

    expect(pack.issue.url).toBeNull();
  });

  /**
   * Routing by module is what makes a workspace with several repositories
   * usable. Without it every run opens whichever checkout the workspace
   * default happens to name, which is right for one repository and wrong for
   * the rest.
   */
  describe('the repository an issue points at', () => {
    const LOCAL = {
      moduleIds: ['module-server'],
      moduleRepos: [
        {
          externalRepoId: 'repo-1',
          fullName: 'vantik',
          integrationAccountId: 'account-1',
          pathPrefixes: ['apps/server/'],
        },
      ],
      slug: 'local-repo',
      localPath: '/Users/dev/code/vantik',
    };

    it('opens the checkout the issue’s module names', async () => {
      const service = buildService(null, LOCAL);

      await expect(service.build('issue-1', WORKSPACE)).resolves.toMatchObject({
        repo: {
          repoPath: '/Users/dev/code/vantik',
          pathPrefixes: ['apps/server/'],
          delivery: 'worktree',
        },
      });
    });

    it('beats the workspace default, which is the answer for an issue that names nothing', async () => {
      const configured = { agentRuns: { repo: { repoPath: '/srv/fallback' } } };

      await expect(
        buildService(configured, LOCAL).build('issue-1', WORKSPACE),
      ).resolves.toMatchObject({ repo: { repoPath: '/Users/dev/code/vantik' } });

      await expect(
        buildService(configured, {}).build('issue-1', WORKSPACE),
      ).resolves.toMatchObject({ repo: { repoPath: '/srv/fallback' } });
    });

    it('loses to an explicit request, because a person knows what the map does not', async () => {
      const service = buildService(null, LOCAL);

      await expect(
        service.build('issue-1', WORKSPACE, { repoPath: '/tmp/somewhere-else' }),
      ).resolves.toMatchObject({ repo: { repoPath: '/tmp/somewhere-else' } });
    });

    it('clones a remote when the module’s repository is not on this disk', async () => {
      const service = buildService(null, {
        moduleIds: ['module-server'],
        moduleRepos: [
          {
            externalRepoId: '123',
            fullName: 'acme/app',
            integrationAccountId: 'account-2',
            pathPrefixes: [],
          },
        ],
        slug: 'github',
      });

      await expect(service.build('issue-1', WORKSPACE)).resolves.toMatchObject({
        repo: {
          repoUrl: 'https://github.com/acme/app.git',
          // A remote to push to is what makes a pull request possible, so the
          // delivery follows from the routing rather than from configuration.
          delivery: 'pull_request',
        },
      });
    });

    it('keeps the prefixes of every module on one repository', async () => {
      const service = buildService(null, {
        ...LOCAL,
        moduleIds: ['module-server', 'module-webapp'],
        moduleRepos: [
          {
            externalRepoId: 'repo-1',
            fullName: 'vantik',
            integrationAccountId: 'account-1',
            pathPrefixes: ['apps/server/'],
          },
          {
            externalRepoId: 'repo-1',
            fullName: 'vantik',
            integrationAccountId: 'account-1',
            pathPrefixes: ['apps/webapp/', 'packages/ui/'],
          },
        ],
      });

      await expect(service.build('issue-1', WORKSPACE)).resolves.toMatchObject({
        repo: {
          repoPath: '/Users/dev/code/vantik',
          pathPrefixes: ['apps/server/', 'apps/webapp/', 'packages/ui/'],
        },
      });
    });

    /**
     * The one that matters. A run in the wrong repository is worse than a run
     * that did not start, so two repositories with no way to choose between
     * them must not resolve to whichever came back first.
     */
    it('refuses to guess when the modules are in different repositories', async () => {
      const service = buildService(
        { agentRuns: { repo: { repoPath: '/srv/fallback' } } },
        {
          moduleIds: ['module-server', 'module-other'],
          moduleRepos: [
            {
              externalRepoId: 'repo-1',
              fullName: 'vantik',
              integrationAccountId: 'account-1',
              pathPrefixes: [],
            },
            {
              externalRepoId: 'repo-2',
              fullName: 'other',
              integrationAccountId: 'account-1',
              pathPrefixes: [],
            },
          ],
          slug: 'local-repo',
          localPath: '/Users/dev/code/vantik',
        },
      );

      const pack = await service.build('issue-1', WORKSPACE);

      expect(pack.repo.repoPath).toBe('/srv/fallback');
      expect(pack.repo.pathPrefixes).toBeUndefined();
    });

    it('falls back rather than half-routing when the path cannot be read back', async () => {
      const service = buildService(
        { agentRuns: { repo: { repoPath: '/srv/fallback' } } },
        { ...LOCAL, localPath: null },
      );

      await expect(service.build('issue-1', WORKSPACE)).resolves.toMatchObject({
        repo: { repoPath: '/srv/fallback' },
      });
    });
  });

  /**
   * How a run checks itself comes from the modules the issue names, for the
   * same reason the repository does: the command depends on the code. A
   * workspace holding a Go service and a pnpm monorepo has no single
   * `testCommand` that is right for both.
   *
   * `chooseVerification` covers how several modules are reconciled. These
   * cover that the answer actually reaches the pack, and how it layers.
   */
  describe('how the run verifies its work', () => {
    const WITH_COMMANDS = {
      ...{
        moduleIds: ['module-server'],
        moduleRepos: [
          {
            externalRepoId: 'repo-1',
            fullName: 'vantik',
            integrationAccountId: 'account-1',
            pathPrefixes: ['apps/server/'],
          },
        ],
        slug: 'local-repo',
        localPath: '/Users/dev/code/vantik',
      },
      moduleVerification: [
        { verification: { testCommand: 'pnpm --filter server test' } },
      ],
    };

    it('takes the commands from the issue’s module', async () => {
      const pack = await buildService(null, WITH_COMMANDS).build(
        'issue-1',
        WORKSPACE,
      );

      expect(pack.repo.testCommand).toBe('pnpm --filter server test');
    });

    it('beats a workspace default left over from when this was configured there', async () => {
      const pack = await buildService(
        { agentRuns: { repo: { testCommand: 'pnpm turbo test' } } },
        WITH_COMMANDS,
      ).build('issue-1', WORKSPACE);

      expect(pack.repo.testCommand).toBe('pnpm --filter server test');
    });

    it('leaves an old workspace default in place when no module says otherwise', async () => {
      // Nothing that worked before this moved stops working.
      const pack = await buildService(
        { agentRuns: { repo: { testCommand: 'pnpm turbo test' } } },
        {},
      ).build('issue-1', WORKSPACE);

      expect(pack.repo.testCommand).toBe('pnpm turbo test');
    });

    it('survives a repository the modules could not agree on', async () => {
      // The two answers are independent. Modules in different repositories
      // still often agree on how to run the tests, and throwing the commands
      // away along with the route would lose that for nothing.
      const pack = await buildService(null, {
        moduleIds: ['module-server', 'module-other'],
        moduleRepos: [
          {
            externalRepoId: 'repo-1',
            fullName: 'vantik',
            integrationAccountId: 'account-1',
            pathPrefixes: [],
          },
          {
            externalRepoId: 'repo-2',
            fullName: 'other',
            integrationAccountId: 'account-1',
            pathPrefixes: [],
          },
        ],
        moduleVerification: [
          { verification: { testCommand: 'make test' } },
          { verification: { testCommand: 'make test' } },
        ],
      }).build('issue-1', WORKSPACE);

      expect(pack.repo.repoPath).toBeUndefined();
      expect(pack.repo.testCommand).toBe('make test');
    });
  });
});
