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

function buildService(preferences: unknown = null) {
  const prisma = {
    workspace: {
      findUnique: jest.fn(() => Promise.resolve({ preferences })),
    },
  } as unknown as PrismaService;

  const context = {
    getIssueContext: jest.fn(() => Promise.resolve(issueContext)),
  } as unknown as IssueContextService;

  return new ContextPackService(prisma, context);
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
});
