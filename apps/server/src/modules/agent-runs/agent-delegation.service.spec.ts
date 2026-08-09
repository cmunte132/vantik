/**
 * Delegation: when a run is created, which backend takes it, and what happens
 * to the issue when one reports back.
 *
 * The guards are the substance. Every one of them exists because the failure
 * it prevents is silent and expensive — two agents on one issue, a scripted
 * loop delegating a whole backlog, an agent handed a one-line issue inventing
 * requirements. None of those throw on their own.
 */
import { BadRequestException } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import type IssueCommentsService from 'modules/issue-comments/issue-comments.service';
import type LinkedIssueService from 'modules/linked-issue/linked-issue.service';

import { RunHandbackService } from './run-handback.service';
import { AgentDelegationService } from './agent-delegation.service';
import type { AgentRunsService } from './agent-runs.service';
import type { ContextPackService } from './context-pack.service';
import { ExecutorRegistry } from './executors/executor.registry';
import type { AgentExecutor } from './executors/executor.interface';

const WORKSPACE = 'workspace-1';
const ISSUE = 'issue-1';
const AGENT = 'agent-1';

const GOOD_DESCRIPTION =
  'The filter endpoint omits a deleted check, so soft-deleted issues come back.';

function fakeExecutor(
  key: string,
  over: Partial<AgentExecutor> = {},
): AgentExecutor {
  return {
    key,
    label: key,
    availability: jest.fn(async () => ({ available: true as const })),
    dispatch: jest.fn(async (): Promise<void> => undefined),
    cancel: jest.fn(async (): Promise<void> => undefined),
    ...over,
  };
}

function build(options: {
  executors?: AgentExecutor[];
  description?: string | null;
  liveRuns?: Array<{ id: string; status: string }>;
  liveCount?: number;
  agentSettings?: unknown;
  preferences?: unknown;
  queuedRuns?: Array<{ id: string; workspaceId: string }>;
  membershipRole?: string;
} = {}) {
  const registry = new ExecutorRegistry();
  for (const executor of options.executors ?? [fakeExecutor('byo')]) {
    registry.register(executor);
  }

  const prisma = {
    issue: {
      findFirst: jest.fn(async () => ({
        id: ISSUE,
        description:
          options.description === undefined
            ? GOOD_DESCRIPTION
            : options.description,
        team: { workspaceId: WORKSPACE },
      })),
    },
    agentRun: {
      findFirst: jest.fn(async () => options.liveRuns?.[0] ?? null),
      findMany: jest.fn(async () => options.queuedRuns ?? []),
      count: jest.fn(async () => options.liveCount ?? 0),
    },
    usersOnWorkspaces: {
      findFirst: jest.fn(async () => ({
        settings: options.agentSettings ?? null,
        role: options.membershipRole ?? RoleEnum.AGENT,
        status: 'ACTIVE',
      })),
    },
    workspace: {
      findUnique: jest.fn(async () => ({
        preferences: options.preferences ?? null,
      })),
    },
  } as unknown as PrismaService;

  const created: unknown[] = [];
  const agentRuns = {
    createRun: jest.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return { id: 'run-1', ...input };
    }),
    transition: jest.fn(async (id: string, status: string, patch: unknown) => ({
      id,
      status,
      patch,
    })),
    getRun: jest.fn(async () => ({
      id: 'run-1',
      issueId: ISSUE,
      agentUserId: AGENT,
      attempt: 1,
      workspaceId: WORKSPACE,
    })),
    cancelRun: jest.fn(async (): Promise<void> => undefined),
  } as unknown as AgentRunsService;

  const contextPacks = {
    build: jest.fn(async () => ({
      version: 1 as const,
      repo: { baseBranch: 'main', delivery: 'worktree' as const },
    })),
  } as unknown as ContextPackService;

  const linked: Array<{ url: string; issueId: string }> = [];
  const linkedIssues = {
    getLinkedIssueByUrl: jest.fn(async (url: string) =>
      linked.filter((entry) => entry.url === url),
    ),
    createLinkIssue: jest.fn(async (data: { url: string }, params: { issueId: string }) => {
      linked.push({ url: data.url, issueId: params.issueId });
      return { id: 'linked-1' };
    }),
  } as unknown as LinkedIssueService;

  const posted: Array<{ issueId: string; userId: string; body: string }> = [];
  const comments = {
    createIssueComment: jest.fn(
      async (
        params: { issueId: string },
        userId: string,
        data: { bodyMarkdown: string },
      ) => {
        posted.push({
          issueId: params.issueId,
          userId,
          body: data.bodyMarkdown,
        });
        return { id: 'comment-1' };
      },
    ),
  } as unknown as IssueCommentsService;

  const service = new AgentDelegationService(
    prisma,
    agentRuns,
    contextPacks,
    registry,
    linkedIssues,
    new RunHandbackService(prisma, comments),
  );

  return { service, prisma, agentRuns, registry, created, posted, linked, linkedIssues };
}

const delegateInput = {
  issueId: ISSUE,
  workspaceId: WORKSPACE,
  agentUserId: AGENT,
  createdById: 'user-1',
};

describe('AgentDelegationService guards', () => {
  it('refuses an issue too thin to act on', async () => {
    const { service, agentRuns } = build({ description: 'fix search' });

    await expect(service.delegate(delegateInput)).rejects.toThrow(
      /invent the requirements it was not given/,
    );
    // And nothing was created on the way to refusing.
    expect(agentRuns.createRun).not.toHaveBeenCalled();
  });

  it('refuses an issue with no description at all', async () => {
    const { service } = build({ description: null });

    await expect(service.delegate(delegateInput)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('measures the text of a tiptap description, not its markup', async () => {
    // A short description wrapped in tiptap JSON is longer than the threshold
    // in bytes while saying almost nothing. Counting the markup would let it
    // through.
    const { service } = build({
      description: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'fix it' }] },
        ],
      }),
    });

    await expect(service.delegate(delegateInput)).rejects.toThrow(
      /too little description/,
    );
  });

  it('refuses a second run while one is already live', async () => {
    const { service } = build({
      liveRuns: [{ id: 'run-existing', status: 'RUNNING' }],
    });

    await expect(service.delegate(delegateInput)).rejects.toThrow(
      /two branches nobody asked for/i,
    );
  });

  it('allows a second run when the caller forces it', async () => {
    const { service, agentRuns } = build({
      liveRuns: [{ id: 'run-existing', status: 'RUNNING' }],
    });

    await service.delegate({ ...delegateInput, force: true });

    expect(agentRuns.createRun).toHaveBeenCalled();
  });

  it('refuses past the workspace concurrency cap', async () => {
    const { service } = build({ liveCount: 5 });

    await expect(service.delegate(delegateInput)).rejects.toThrow(
      /cap/,
    );
  });

  it('refuses an issue from another workspace', async () => {
    const { service } = build();

    await expect(
      service.delegate({ ...delegateInput, workspaceId: 'workspace-other' }),
    ).rejects.toThrow(/not found in this workspace/);
  });

  it('refuses when the executor says it cannot run here', async () => {
    const { service } = build({
      executors: [
        fakeExecutor('hosted', {
          availability: async () => ({
            available: false,
            reason: 'This workspace has no model credentials configured.',
          }),
        }),
      ],
    });

    // The reason is the point: "unavailable" is a support ticket, "no
    // credentials configured" is a settings page.
    await expect(service.delegate(delegateInput)).rejects.toThrow(
      /no model credentials configured/,
    );
  });
});

describe('AgentDelegationService routing', () => {
  it('prefers the executor the request named', async () => {
    const { service, created } = build({
      executors: [fakeExecutor('byo'), fakeExecutor('hosted')],
      agentSettings: { agent: { executor: 'hosted' } },
      preferences: { agentRuns: { defaultExecutor: 'hosted' } },
    });

    await service.delegate({ ...delegateInput, executor: 'byo' });

    expect(created[0]).toMatchObject({ executor: 'byo' });
  });

  it('falls back to the executor the agent account is bound to', async () => {
    const { service, created } = build({
      executors: [fakeExecutor('byo'), fakeExecutor('hosted')],
      agentSettings: { agent: { executor: 'hosted' } },
      preferences: { agentRuns: { defaultExecutor: 'byo' } },
    });

    await service.delegate(delegateInput);

    expect(created[0]).toMatchObject({ executor: 'hosted' });
  });

  it('falls back to the workspace default', async () => {
    const { service, created } = build({
      executors: [fakeExecutor('byo'), fakeExecutor('hosted')],
      preferences: { agentRuns: { defaultExecutor: 'hosted' } },
    });

    await service.delegate(delegateInput);

    expect(created[0]).toMatchObject({ executor: 'hosted' });
  });

  it('uses the only executor there is rather than demanding a choice', async () => {
    const { service, created } = build({ executors: [fakeExecutor('byo')] });

    await service.delegate(delegateInput);

    expect(created[0]).toMatchObject({ executor: 'byo' });
  });

  it('asks which one when several are registered and none is configured', async () => {
    const { service } = build({
      executors: [fakeExecutor('byo'), fakeExecutor('hosted')],
    });

    await expect(service.delegate(delegateInput)).rejects.toThrow(
      /name one/,
    );
  });

  it('names what exists when an unknown executor is asked for', async () => {
    const { service } = build({ executors: [fakeExecutor('byo')] });

    // A typo would otherwise surface as a run nobody ever claims, which looks
    // exactly like a runner being offline.
    await expect(
      service.delegate({ ...delegateInput, executor: 'hostd' }),
    ).rejects.toThrow(/No executor "hostd". Available: byo/);
  });

  it('records a dispatch failure on the run instead of dropping it', async () => {
    const { service, agentRuns } = build({
      executors: [
        fakeExecutor('hosted', {
          dispatch: async () => {
            throw new Error('sandbox host unreachable');
          },
        }),
      ],
    });

    await service.delegate(delegateInput);

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({ failure: 'ENVIRONMENT_SETUP_FAILED' }),
    );
  });

  it('carries the workspace’s phase switches onto the run', async () => {
    // These were parsed out of the workspace's preferences and then dropped:
    // the run config was built from the repo and the model alone, so
    // `config.phases` was undefined on every run ever dispatched and an
    // executor could not act on a setting somebody had deliberately set.
    const { service, created } = build({
      preferences: { agentRuns: { phases: { review: false, specify: true } } },
    });

    await service.delegate(delegateInput);

    expect((created[0] as { config: unknown }).config).toMatchObject({
      phases: { review: false, specify: true },
    });
  });

  it('lets the request override one phase without losing the others', async () => {
    const { service, created } = build({
      preferences: { agentRuns: { phases: { review: true, score: true } } },
    });

    await service.delegate({
      ...delegateInput,
      config: { phases: { review: false } },
    });

    expect((created[0] as { config: unknown }).config).toMatchObject({
      phases: { review: false, score: true },
    });
  });

  it('stores the ceilings the run was delegated under', async () => {
    // Stored rather than resolved again at dispatch, so raising the workspace
    // limit later cannot rewrite what a finished run was held to.
    const { service, created } = build();

    await service.delegate({
      ...delegateInput,
      config: { limits: { maxCycles: 1, maxCostUsd: 2 } },
    });

    expect((created[0] as { config: unknown }).config).toMatchObject({
      limits: { maxCycles: 1, maxCostUsd: 2 },
    });
  });

  it('leaves phases off the config when nothing set one', async () => {
    // An empty object here would be a workspace that had configured nothing
    // looking, on the row, like one that had configured everything to default.
    const { service, created } = build();

    await service.delegate(delegateInput);

    expect((created[0] as { config: Record<string, unknown> }).config).not.toHaveProperty(
      'phases',
    );
  });

  it('stores a config hash that does not depend on key order', async () => {
    const a = build();
    const b = build();

    await a.service.delegate(delegateInput);
    await b.service.delegate(delegateInput);

    const hashOf = (created: unknown[]) =>
      (created[0] as { configHash: string }).configHash;

    expect(hashOf(a.created)).toBe(hashOf(b.created));
    expect(hashOf(a.created)).toHaveLength(16);
  });
});

describe('AgentDelegationService assignment trigger', () => {
  it('enqueues a run when an issue is assigned to an agent', async () => {
    const { service, agentRuns } = build();

    await service.onAssigneeChanged(ISSUE, WORKSPACE, null, AGENT, 'user-1');

    expect(agentRuns.createRun).toHaveBeenCalled();
  });

  it('does nothing when the assignee did not actually change', async () => {
    const { service, agentRuns } = build();

    await service.onAssigneeChanged(ISSUE, WORKSPACE, AGENT, AGENT, 'user-1');

    expect(agentRuns.createRun).not.toHaveBeenCalled();
  });

  it('ignores assignment to a human', async () => {
    const { service, agentRuns } = build({ membershipRole: RoleEnum.USER });

    await service.onAssigneeChanged(ISSUE, WORKSPACE, null, 'user-2', 'user-1');

    expect(agentRuns.createRun).not.toHaveBeenCalled();
  });

  it('withdraws queued work when the issue moves back to a human', async () => {
    const { service, agentRuns } = build({
      queuedRuns: [{ id: 'run-queued', workspaceId: WORKSPACE }],
      membershipRole: RoleEnum.AGENT,
    });

    await service.onAssigneeChanged(ISSUE, WORKSPACE, AGENT, null, 'user-1');

    expect(agentRuns.cancelRun).toHaveBeenCalledWith(
      'run-queued',
      { workspaceId: WORKSPACE },
      expect.stringContaining('reassigned'),
    );
  });

  it('never fails the assignment when delegation cannot start', async () => {
    // A thin issue assigned to an agent is a normal thing to do. It must not
    // make the assignment itself fail.
    const { service } = build({ description: 'fix' });

    await expect(
      service.onAssigneeChanged(ISSUE, WORKSPACE, null, AGENT, 'user-1'),
    ).resolves.toBeUndefined();
  });
});

describe('AgentDelegationService handback', () => {
  it('links the pull request and comments as the agent', async () => {
    const { service, posted, linked } = build();

    await service.report(
      'run-1',
      {
        summary: 'Added the deleted check and a regression test.',
        branch: 'agent/eng-42',
        prUrl: 'https://example.test/pr/7',
      },
      WORKSPACE,
    );

    expect(linked).toEqual([
      { url: 'https://example.test/pr/7', issueId: ISSUE },
    ]);
    // Authored by the agent user, not by whoever delegated.
    expect(posted[0]).toMatchObject({ issueId: ISSUE, userId: AGENT });
    expect(posted[0].body).toContain('https://example.test/pr/7');
  });

  it('does not link the same pull request twice', async () => {
    const { service, linkedIssues } = build();

    const report = {
      branch: 'agent/eng-42',
      prUrl: 'https://example.test/pr/7',
    };

    // A runner retrying an HTTP call must not leave the issue carrying the
    // same pull request twice.
    await service.report('run-1', report, WORKSPACE);
    await service.report('run-1', report, WORKSPACE);

    expect(linkedIssues.createLinkIssue).toHaveBeenCalledTimes(1);
  });

  it('hands back a worktree path with a command to reach it', async () => {
    const { service, posted, linkedIssues } = build();

    await service.report(
      'run-1',
      {
        summary: 'Done.',
        branch: 'agent/eng-42',
        worktreePath: '/Users/dev/worktrees/eng-42',
      },
      WORKSPACE,
    );

    expect(posted[0].body).toContain('cd /Users/dev/worktrees/eng-42');
    expect(posted[0].body).toContain('agent/eng-42');
    // No remote, so nothing to link.
    expect(linkedIssues.createLinkIssue).not.toHaveBeenCalled();
  });

  it('derives delivery from what the run actually produced', async () => {
    const { service, agentRuns } = build();

    await service.report(
      'run-1',
      { worktreePath: '/tmp/wt' },
      WORKSPACE,
    );

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'SUCCEEDED',
      expect.objectContaining({
        result: expect.objectContaining({ delivery: 'worktree' }),
      }),
    );
  });

  it('reports a failure as FAILED with readable prose', async () => {
    const { service, agentRuns, posted } = build();

    await service.report(
      'run-1',
      { failure: 'ENVIRONMENT_SETUP_FAILED', error: 'pnpm install exited 1' },
      WORKSPACE,
    );

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({ failure: 'ENVIRONMENT_SETUP_FAILED' }),
    );
    // A failed run deserves as much design as a successful one.
    expect(posted[0].body).toContain('the environment would not build');
    expect(posted[0].body).toContain('pnpm install exited 1');
  });

  it('routes an unverifiable result to human review, not to failure', async () => {
    const { service, agentRuns, posted } = build();

    await service.report(
      'run-1',
      { needsReview: true, summary: 'This issue cannot be pinned down with tests.' },
      WORKSPACE,
    );

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'NEEDS_REVIEW',
      expect.anything(),
    );
    expect(posted[0].body).toContain('Needs a human');
  });

  it('never lets an executor choose its own status', async () => {
    const { service, agentRuns } = build();

    // A failure and a "needs review" together must not resolve to SUCCEEDED.
    await service.report(
      'run-1',
      { failure: 'HARNESS_CRASHED', needsReview: true },
      WORKSPACE,
    );

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.anything(),
    );
  });
});
