/**
 * The database side of module routing.
 *
 * `module-routing.spec.ts` holds the rules that decide which module a path
 * belongs to. This file holds what the service does around them: which rows it
 * reads, when it writes, and when it leaves the issue alone.
 *
 * The workspace scope is the part that matters most. A `ModuleRepo` row carries
 * the identifier of a repository and not a workspace, and two workspaces can
 * connect the same repository. A query that forgets the workspace therefore
 * gives the issue of one company a module of another.
 */
import { PrismaService } from 'nestjs-prisma';

import { ModuleRoutingService } from './module-routing.service';

const ISSUE = 'issue-1';
const WORKSPACE = 'workspace-mine';
const REPO = '123456';

interface IssueRow {
  id: string;
  moduleIds: string[];
  team: { workspaceId: string };
}

interface RepoRow {
  moduleId: string;
  pathPrefixes: string[];
}

function buildService(options: {
  issue?: IssueRow | null;
  repos?: RepoRow[];
  /** The issues that a key lookup finds. */
  found?: Array<{ id: string }>;
}) {
  const issue =
    options.issue === undefined
      ? { id: ISSUE, moduleIds: [], team: { workspaceId: WORKSPACE } }
      : options.issue;

  const prisma = {
    issue: {
      findFirst: jest.fn().mockResolvedValue(issue),
      findMany: jest.fn().mockResolvedValue(options.found ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    moduleRepo: {
      findMany: jest.fn().mockResolvedValue(options.repos ?? []),
    },
  } as unknown as PrismaService;

  return { service: new ModuleRoutingService(prisma), prisma };
}

const updateData = (prisma: PrismaService) =>
  (prisma.issue.update as jest.Mock).mock.calls[0][0].data;

const repoWhere = (prisma: PrismaService) =>
  (prisma.moduleRepo.findMany as jest.Mock).mock.calls[0][0].where;

describe('ModuleRoutingService.routePullRequest', () => {
  /** A pull request touching one module's prefixes sets that module. */
  it('writes the module that the pull request changed', async () => {
    const { service, prisma } = buildService({
      repos: [{ moduleId: 'module-server', pathPrefixes: ['apps/server/'] }],
    });

    const result = await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: ['apps/server/src/main.ts'],
      issueId: ISSUE,
    });

    expect(updateData(prisma)).toEqual({ moduleIds: ['module-server'] });
    expect(result).toEqual(['module-server']);
  });

  /** A pull request touching two modules' prefixes sets both. */
  it('writes both modules when the pull request crosses them', async () => {
    const { service, prisma } = buildService({
      repos: [
        { moduleId: 'module-server', pathPrefixes: ['apps/server/'] },
        { moduleId: 'module-webapp', pathPrefixes: ['apps/webapp/'] },
      ],
    });

    await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: ['apps/server/src/main.ts', 'apps/webapp/src/page.tsx'],
      issueId: ISSUE,
    });

    expect(updateData(prisma)).toEqual({
      moduleIds: ['module-server', 'module-webapp'],
    });
  });

  /** A module a person set by hand survives a pull request for another one. */
  it('keeps the module that a person set by hand', async () => {
    const { service, prisma } = buildService({
      issue: {
        id: ISSUE,
        moduleIds: ['module-chosen'],
        team: { workspaceId: WORKSPACE },
      },
      repos: [{ moduleId: 'module-server', pathPrefixes: ['apps/server/'] }],
    });

    await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: ['apps/server/src/main.ts'],
      issueId: ISSUE,
    });

    expect(updateData(prisma)).toEqual({
      moduleIds: ['module-chosen', 'module-server'],
    });
  });

  /** A module with empty pathPrefixes resolves for any path in the repository. */
  it('writes a whole-repository module for any changed path', async () => {
    const { service, prisma } = buildService({
      repos: [{ moduleId: 'module-all', pathPrefixes: [] }],
    });

    await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: ['README.md'],
      issueId: ISSUE,
    });

    expect(updateData(prisma)).toEqual({ moduleIds: ['module-all'] });
  });

  /** A webhook for a repository with no ModuleRepo row assigns nothing. */
  it('writes nothing when the repository maps to no module', async () => {
    const { service, prisma } = buildService({ repos: [] });

    const result = await service.routePullRequest({
      externalRepoId: 'a-repository-nobody-mapped',
      changedPaths: ['apps/server/src/main.ts'],
      issueId: ISSUE,
    });

    expect(prisma.issue.update).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('writes nothing when the changed paths reach no module', async () => {
    const { service, prisma } = buildService({
      repos: [{ moduleId: 'module-server', pathPrefixes: ['apps/server/'] }],
    });

    await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: ['docs/readme.md'],
      issueId: ISSUE,
    });

    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it('writes nothing when the issue already holds the module', async () => {
    const { service, prisma } = buildService({
      issue: {
        id: ISSUE,
        moduleIds: ['module-server'],
        team: { workspaceId: WORKSPACE },
      },
      repos: [{ moduleId: 'module-server', pathPrefixes: ['apps/server/'] }],
    });

    await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: ['apps/server/src/main.ts'],
      issueId: ISSUE,
    });

    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it('handles a pull request for an issue that does not exist', async () => {
    const { service, prisma } = buildService({ issue: null });

    const result = await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: ['apps/server/src/main.ts'],
      issueId: 'gone',
    });

    expect(result).toEqual([]);
    expect(prisma.issue.update).not.toHaveBeenCalled();
    expect(prisma.moduleRepo.findMany).not.toHaveBeenCalled();
  });

  /**
   * The leak this guards: two workspaces connect the same repository, and a
   * query on `externalRepoId` alone returns the rows of both.
   */
  it('reads only the rows of the workspace that owns the issue', async () => {
    const { service, prisma } = buildService({
      repos: [{ moduleId: 'module-server', pathPrefixes: ['apps/server/'] }],
    });

    await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: ['apps/server/src/main.ts'],
      issueId: ISSUE,
    });

    expect(repoWhere(prisma)).toEqual({
      externalRepoId: REPO,
      deleted: null,
      module: { workspaceId: WORKSPACE, deleted: null },
    });
  });

  it('reads no deleted issue', async () => {
    const { service, prisma } = buildService({});

    await service.routePullRequest({
      externalRepoId: REPO,
      changedPaths: [],
      issueId: ISSUE,
    });

    expect(
      (prisma.issue.findFirst as jest.Mock).mock.calls[0][0].where,
    ).toEqual({ id: ISSUE, deleted: null });
  });
});

/**
 * A webhook names an issue by its key, because that is what a person writes in
 * a pull request. These tests hold the step that turns a key into an issue.
 */
describe('ModuleRoutingService.routeCodeChange', () => {
  const keyWhere = (prisma: PrismaService) =>
    (prisma.issue.findMany as jest.Mock).mock.calls[0][0].where;

  it('looks for the issue of each key inside the workspace', async () => {
    const { service, prisma } = buildService({ found: [] });

    await service.routeCodeChange(
      {
        externalRepoId: REPO,
        changedPaths: ['apps/server/src/main.ts'],
        issueKeys: ['ENG-42', 'OPS-7'],
      },
      WORKSPACE,
    );

    expect(keyWhere(prisma)).toEqual({
      deleted: null,
      team: { workspaceId: WORKSPACE },
      OR: [
        { number: 42, team: { identifier: 'ENG', workspaceId: WORKSPACE } },
        { number: 7, team: { identifier: 'OPS', workspaceId: WORKSPACE } },
      ],
    });
  });

  it('routes the change to every issue that a key found', async () => {
    const { service, prisma } = buildService({
      found: [{ id: 'issue-1' }, { id: 'issue-2' }],
      repos: [{ moduleId: 'module-server', pathPrefixes: ['apps/server/'] }],
    });

    await service.routeCodeChange(
      {
        externalRepoId: REPO,
        changedPaths: ['apps/server/src/main.ts'],
        issueKeys: ['ENG-42', 'ENG-43'],
      },
      WORKSPACE,
    );

    expect((prisma.issue.update as jest.Mock).mock.calls).toHaveLength(2);
  });

  /**
   * `issueKeysIn` reads any word that has the shape of a key, so `UTF-8`
   * arrives here. A workspace with no team called UTF finds no issue, and
   * nothing is written.
   */
  it('writes nothing when a key matches no issue', async () => {
    const { service, prisma } = buildService({ found: [] });

    await service.routeCodeChange(
      {
        externalRepoId: REPO,
        changedPaths: ['apps/server/src/main.ts'],
        issueKeys: ['UTF-8'],
      },
      WORKSPACE,
    );

    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it('reads nothing when no key has the shape of a key', async () => {
    const { service, prisma } = buildService({ found: [] });

    await service.routeCodeChange(
      {
        externalRepoId: REPO,
        changedPaths: ['apps/server/src/main.ts'],
        issueKeys: ['not-a-key', ''],
      },
      WORKSPACE,
    );

    expect(prisma.issue.findMany).not.toHaveBeenCalled();
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });
});
