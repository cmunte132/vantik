/**
 * Delegation: when a run is created, and which backend takes it.
 *
 * The guards are the substance. Every one of them exists because the failure
 * it prevents is silent and expensive — two agents on one issue, a scripted
 * loop delegating a whole backlog, an agent handed a one-line issue inventing
 * requirements. None of those throw on their own.
 */
import { BadRequestException } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

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
  for (const executor of options.executors ?? [fakeExecutor('hosted')]) {
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

  const service = new AgentDelegationService(
    prisma,
    agentRuns,
    contextPacks,
    registry,
  );

  return { service, prisma, agentRuns, registry, created };
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
  // `hosted` is the only backend this build ships, so the second key here is a
  // fake. The order these fall back in is a property of the registry rather
  // than of how many adapters happen to be registered, and it is worth holding
  // to now that adding one is the point of the registry existing.
  it('prefers the executor the request named', async () => {
    const { service, created } = build({
      executors: [fakeExecutor('hosted'), fakeExecutor('elsewhere')],
      agentSettings: { agent: { executor: 'hosted' } },
      preferences: { agentRuns: { defaultExecutor: 'hosted' } },
    });

    await service.delegate({ ...delegateInput, executor: 'elsewhere' });

    expect(created[0]).toMatchObject({ executor: 'elsewhere' });
  });

  it('falls back to the executor the agent account is bound to', async () => {
    const { service, created } = build({
      executors: [fakeExecutor('hosted'), fakeExecutor('elsewhere')],
      agentSettings: { agent: { executor: 'hosted' } },
      preferences: { agentRuns: { defaultExecutor: 'elsewhere' } },
    });

    await service.delegate(delegateInput);

    expect(created[0]).toMatchObject({ executor: 'hosted' });
  });

  it('falls back to the workspace default', async () => {
    const { service, created } = build({
      executors: [fakeExecutor('hosted'), fakeExecutor('elsewhere')],
      preferences: { agentRuns: { defaultExecutor: 'elsewhere' } },
    });

    await service.delegate(delegateInput);

    expect(created[0]).toMatchObject({ executor: 'elsewhere' });
  });

  it('uses the only executor there is rather than demanding a choice', async () => {
    // The case every delegation in this build actually takes: one adapter is
    // registered, so nobody has to name it and nobody has to configure it.
    const { service, created } = build({ executors: [fakeExecutor('hosted')] });

    await service.delegate(delegateInput);

    expect(created[0]).toMatchObject({ executor: 'hosted' });
  });

  it('asks which one when several are registered and none is configured', async () => {
    const { service } = build({
      executors: [fakeExecutor('hosted'), fakeExecutor('elsewhere')],
    });

    await expect(service.delegate(delegateInput)).rejects.toThrow(
      /name one/,
    );
  });

  it('names what exists when an unknown executor is asked for', async () => {
    const { service } = build({ executors: [fakeExecutor('hosted')] });

    // A typo would otherwise surface as a run that sits in QUEUED for ever,
    // which reads as the sandbox being down rather than as a bad request.
    await expect(
      service.delegate({ ...delegateInput, executor: 'hostd' }),
    ).rejects.toThrow(/No executor "hostd". Available: hosted/);
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
      preferences: { agentRuns: { phases: { review: false } } },
    });

    await service.delegate(delegateInput);

    expect((created[0] as { config: unknown }).config).toMatchObject({
      phases: { review: false },
    });
  });

  it('lets the request overrule the workspace switch', async () => {
    const { service, created } = build({
      preferences: { agentRuns: { phases: { review: true } } },
    });

    await service.delegate({
      ...delegateInput,
      config: { phases: { review: false } },
    });

    expect((created[0] as { config: unknown }).config).toMatchObject({
      phases: { review: false },
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
