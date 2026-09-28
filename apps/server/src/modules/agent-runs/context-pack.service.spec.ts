/**
 * The context pack: what every executor is handed, identically.
 *
 * Snapshot-tested because the pack's *shape* is the contract. A field quietly
 * disappearing is not a crash anywhere — the agent simply stops being told
 * something, produces slightly worse work, and nothing fails. The snapshot is
 * the only thing that notices.
 */
import { PrismaService } from 'nestjs-prisma';

import type {
  GitSourcesService,
  RepoRef,
} from 'modules/git/git-sources.service';
import type { IssueContext } from 'modules/issues/issue-context.interface';
import type IssueContextService from 'modules/issues/issue-context.service';
import type KnowledgeService from 'modules/pages/knowledge.service';

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
    {
      id: 'issue-2',
      key: 'ENG-43',
      title: 'Add the regression test',
      stateCategory: 'COMPLETED',
    },
    {
      id: 'issue-3',
      key: 'ENG-44',
      title: 'Backfill the index',
      stateCategory: 'BACKLOG',
    },
  ],
  relations: [
    {
      type: 'BLOCKS',
      issue: { id: 'issue-9', key: 'ENG-50', title: 'Ship search v2' },
    },
  ],
  linkedIssues: [
    { url: 'https://example.test/pr/1', title: 'Earlier attempt' },
  ],
  criteria: [
    {
      id: 'c1',
      body: 'Deleted issues never appear in filter results',
      completed: false,
    },
    {
      id: 'c2',
      body: 'A regression test covers the soft-delete case',
      completed: true,
    },
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
  /** Which kind of source resolves the repository. */
  source?: 'github' | 'local-repo';
  /** Why the repository does not resolve, when it does not. */
  unresolved?: string;
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
  } as unknown as PrismaService;

  const context = {
    getIssueContext: jest.fn(() => Promise.resolve(issueContext)),
  } as unknown as IssueContextService;

  const gitSources = {
    resolve: jest.fn(async (ref: RepoRef) => {
      if (routing.unresolved) {
        return { unresolved: routing.unresolved };
      }

      const row = routing.moduleRepos?.find(
        (candidate) => candidate.externalRepoId === ref.externalRepoId,
      );
      const github = routing.source === 'github';

      return {
        source: {
          location: () =>
            github
              ? `https://github.com/${row?.fullName}`
              : `/Users/dev/code/${row?.fullName}`,
          ...(github ? { openChangeRequest: jest.fn() } : {}),
        },
        repo: {
          integrationAccountId: ref.integrationAccountId,
          externalRepoId: ref.externalRepoId,
          fullName: row?.fullName,
        },
      };
    }),
  } as unknown as GitSourcesService;

  return new ContextPackService(prisma, context, gitSources, knowledgeDouble());
}

const PACKED = {
  entryId: 'entry-1',
  kind: 'CONVENTION',
  scope: 'apps/server',
  body: 'Filters always carry deleted: null.',
  writtenAt: '2026-08-01T09:00:00.000Z',
  trust: 'GROUNDED',
  citations: [] as unknown[],
  lastCheckedAt: null as string | null,
  lastCheckedSha: null as string | null,
};

function knowledgeDouble() {
  return {
    knowledgeForRun: jest.fn(async () => [PACKED]),
    recordPacked: jest.fn(async (): Promise<void> => undefined),
  } as unknown as KnowledgeService;
}

/** The service and its knowledge double, for the tests that look at both. */
function withKnowledge() {
  const service = buildService();
  const knowledge = (service as unknown as { knowledge: KnowledgeService })
    .knowledge;
  return { service, knowledge };
}

const LOCAL: Routing = {
  moduleIds: ['module-server'],
  moduleRepos: [
    {
      externalRepoId: 'repo-1',
      fullName: 'vantik',
      integrationAccountId: 'account-1',
      pathPrefixes: ['apps/server/'],
    },
  ],
  source: 'local-repo',
};

const VANTIK_SOURCE = {
  integrationAccountId: 'account-1',
  externalRepoId: 'repo-1',
  fullName: 'vantik',
};

describe('ContextPackService', () => {
  const originalHost = process.env.FRONTEND_HOST;

  beforeAll(() => {
    process.env.FRONTEND_HOST = 'https://vantik.test';
  });

  afterAll(() => {
    process.env.FRONTEND_HOST = originalHost;
  });

  it('hands every executor the same pack', async () => {
    const service = buildService(
      {
        agentRuns: {
          repo: {
            baseBranch: 'main',
            setupCommands: ['pnpm install --frozen-lockfile'],
            testCommand: 'pnpm test',
            lintCommand: 'pnpm lint',
            typecheckCommand: 'pnpm typecheck',
          },
        },
      },
      LOCAL,
    );

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
    "lintCommand": "pnpm lint",
    "location": "/Users/dev/code/vantik",
    "pathPrefixes": [
      "apps/server/",
    ],
    "setupCommands": [
      "pnpm install --frozen-lockfile",
    ],
    "source": {
      "externalRepoId": "repo-1",
      "fullName": "vantik",
      "integrationAccountId": "account-1",
    },
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
    expect(
      (await service.build('issue-1', WORKSPACE, undefined, '   ')).guidance,
    ).toBeUndefined();
    expect(
      (await service.build('issue-1', WORKSPACE)).guidance,
    ).toBeUndefined();
  });

  it('carries the repo’s verification commands, not just its address', async () => {
    const service = buildService({
      agentRuns: { repo: { testCommand: 'pnpm test' } },
    });

    const pack = await service.build('issue-1', WORKSPACE);

    // The single highest-leverage field in the pack. Without it every runner
    // re-derives the commands by guessing, and "the agent could not run
    // anything" is the most common failure these systems have.
    expect(pack.repo.testCommand).toBe('pnpm test');
  });

  it('lets the delegating caller override the workspace default', async () => {
    const service = buildService({
      agentRuns: { repo: { baseBranch: 'main', testCommand: 'pnpm test' } },
    });

    const pack = await service.build('issue-1', WORKSPACE, {
      baseBranch: 'release/2026-07',
    });

    expect(pack.repo).toMatchObject({
      baseBranch: 'release/2026-07',
      // Untouched fields survive the override rather than being blanked.
      testCommand: 'pnpm test',
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
      repo: {},
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
   * usable, and it is now the only way a run gets a repository at all: a
   * repository is something a workspace connects, not a string a caller types.
   */
  describe('the repository an issue points at', () => {
    it('opens the repository the issue’s module names, as a source reference', async () => {
      const service = buildService(null, LOCAL);

      await expect(service.build('issue-1', WORKSPACE)).resolves.toMatchObject({
        repo: {
          source: VANTIK_SOURCE,
          location: '/Users/dev/code/vantik',
          pathPrefixes: ['apps/server/'],
        },
      });
    });

    it('takes no repository from a workspace default or a request', async () => {
      const smuggled = {
        source: {
          integrationAccountId: 'x',
          externalRepoId: 'y',
          fullName: 'evil',
        },
        location: '/etc',
        repoUrl: 'https://attacker.test/repo.git',
        repoPath: '/etc',
      };
      const service = buildService({ agentRuns: { repo: smuggled } }, {});

      const pack = await service.build(
        'issue-1',
        WORKSPACE,
        smuggled as unknown as Parameters<ContextPackService['build']>[2],
      );

      expect(pack.repo).toEqual({});
    });

    it('names a GitHub repository by its page, and plans a pull request for it', async () => {
      const routing: Routing = {
        moduleIds: ['module-server'],
        moduleRepos: [
          {
            externalRepoId: '123',
            fullName: 'acme/app',
            integrationAccountId: 'account-2',
            pathPrefixes: [],
          },
        ],
        source: 'github',
      };

      await expect(
        buildService(null, routing).build('issue-1', WORKSPACE),
      ).resolves.toMatchObject({
        repo: {
          source: {
            integrationAccountId: 'account-2',
            externalRepoId: '123',
            fullName: 'acme/app',
          },
          location: 'https://github.com/acme/app',
        },
      });
      await expect(
        buildService(null, routing).plan('issue-1', WORKSPACE),
      ).resolves.toMatchObject({ delivery: 'pull_request' });
    });

    it('plans a pushed branch for a source with no pull requests', async () => {
      await expect(
        buildService(null, LOCAL).plan('issue-1', WORKSPACE),
      ).resolves.toMatchObject({ delivery: 'branch' });
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
          source: VANTIK_SOURCE,
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
      const service = buildService(null, {
        ...LOCAL,
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
      });

      const pack = await service.build('issue-1', WORKSPACE);

      expect(pack.repo.source).toBeUndefined();
      expect(pack.repo.pathPrefixes).toBeUndefined();
    });

    it('gives no repository, rather than half a route, when the source no longer offers it', async () => {
      const service = buildService(null, {
        ...LOCAL,
        unresolved: 'the connected source no longer offers this repository',
      });

      const pack = await service.build('issue-1', WORKSPACE);

      expect(pack.repo.source).toBeUndefined();
      expect(pack.repo.pathPrefixes).toBeUndefined();
      await expect(service.plan('issue-1', WORKSPACE)).resolves.toMatchObject({
        delivery: null,
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
    const WITH_COMMANDS: Routing = {
      ...LOCAL,
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
        ...LOCAL,
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

      expect(pack.repo.source).toBeUndefined();
      expect(pack.repo.testCommand).toBe('make test');
    });
  });
});

describe('the knowledge in a pack', () => {
  it('[KG-3.2] hands a run in the treatment arm what the workspace knows about its issue', async () => {
    const { service, knowledge } = withKnowledge();

    const pack = await service.build(
      'issue-1',
      WORKSPACE,
      undefined,
      undefined,
      'TREATMENT',
    );

    expect(pack.knowledge).toEqual([PACKED]);
    // Asked by the issue's title, which is what the work is about.
    expect(knowledge.knowledgeForRun).toHaveBeenCalledWith(WORKSPACE, {
      issueId: 'issue-1',
      query: 'Search returns deleted issues',
    });
  });

  it('[KG-3.3] hands a held-out run no knowledge, and does not look any up', async () => {
    const { service, knowledge } = withKnowledge();

    const held = await service.build(
      'issue-1',
      WORKSPACE,
      undefined,
      undefined,
      'HOLDOUT',
    );
    const unassigned = await service.build('issue-1', WORKSPACE);

    expect(held.knowledge).toEqual([]);
    expect(unassigned.knowledge).toEqual([]);
    expect(knowledge.knowledgeForRun).not.toHaveBeenCalled();
  });

  it('[KG-3.1] records what a treatment run was packed as served to that run', async () => {
    const { service, knowledge } = withKnowledge();
    const run = {
      id: 'run-1',
      workspaceId: WORKSPACE,
      agentUserId: 'agent-1',
      knowledgeArm: 'TREATMENT' as const,
      contextPack: { knowledge: [PACKED, { ...PACKED, entryId: 'entry-2' }] },
    };

    await service.recordServed(run);

    expect(knowledge.recordPacked).toHaveBeenCalledWith(WORKSPACE, run, [
      'entry-1',
      'entry-2',
    ]);
  });

  it('[KG-3.3] records no uses for a held-out run, which was served nothing', async () => {
    const { service, knowledge } = withKnowledge();

    await service.recordServed({
      id: 'run-1',
      workspaceId: WORKSPACE,
      agentUserId: 'agent-1',
      knowledgeArm: 'HOLDOUT',
      // Even were a pack to carry knowledge, a holdout records none.
      contextPack: { knowledge: [PACKED] },
    });
    await service.recordServed({
      id: 'run-2',
      workspaceId: WORKSPACE,
      agentUserId: 'agent-1',
      knowledgeArm: 'TREATMENT',
      contextPack: { knowledge: [] },
    });

    expect(knowledge.recordPacked).not.toHaveBeenCalled();
  });
});
