/**
 * Delegation: when a run is created, and which backend takes it.
 *
 * The guards are the substance. Every one of them exists because the failure
 * it prevents is silent and expensive — two agents on one issue, a scripted
 * loop delegating a whole backlog, an agent handed a one-line issue inventing
 * requirements. None of those throw on their own.
 */
import type { AgentRunsService } from './agent-runs.service';
import type { ContextPackService } from './context-pack.service';
import type { AgentExecutor } from './executors/executor.interface';

import { BadRequestException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import type { PackTraceDraft } from 'modules/pages/knowledge.service';

import { AgentDelegationService } from './agent-delegation.service';
import { ExecutorRegistry } from './executors/executor.registry';
import { knowledgeArmFor } from './knowledge-arm';

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

function build(
  options: {
    executors?: AgentExecutor[];
    description?: string | null;
    liveRuns?: Array<{ id: string; status: string }>;
    liveCount?: number;
    agentSettings?: unknown;
    preferences?: unknown;
  } = {},
) {
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
      count: jest.fn(async () => options.liveCount ?? 0),
    },
    usersOnWorkspaces: {
      findFirst: jest.fn(async () => ({
        settings: options.agentSettings ?? null,
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
    cancelRun: jest.fn(async (runId: string) => ({
      id: runId,
      executor: options.executors?.[0]?.key ?? 'hosted',
      status: 'CANCELED',
    })),
    retryRun: jest.fn(async (runId: string) => ({
      id: `${runId}-next`,
      executor: options.executors?.[0]?.key ?? 'hosted',
      attempt: 2,
    })),
  } as unknown as AgentRunsService;

  const trace: PackTraceDraft = {
    query: 'the issue',
    seedModuleIds: [],
    neighbourModuleIds: [],
    topK: 5,
    tokenBudget: 1500,
    tokensGiven: 0,
    searchFailed: false,
    candidates: [],
  };
  const contextPacks = {
    buildTraced: jest.fn(async () => ({
      pack: {
        version: 1 as const,
        repo: { baseBranch: 'main', delivery: 'worktree' as const },
      },
      trace,
    })),
    recordServed: jest.fn(async (): Promise<void> => undefined),
  } as unknown as ContextPackService;

  const service = new AgentDelegationService(
    prisma,
    agentRuns,
    contextPacks,
    registry,
  );

  return { service, prisma, agentRuns, registry, created, contextPacks };
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

    await expect(service.delegate(delegateInput)).rejects.toThrow(/cap/);
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

  it('does not force the workspace default model onto a local run', async () => {
    const { service, created } = build({
      executors: [fakeExecutor('hosted'), fakeExecutor('local')],
      preferences: {
        agentRuns: {
          defaultExecutor: 'hosted',
          model: { provider: 'openai', model: 'gpt-5' },
        },
      },
    });

    await service.delegate({
      ...delegateInput,
      executor: 'local',
      config: { thinking: 'high' },
    });

    const config = (created[0] as { config: Record<string, unknown> }).config;
    expect(config.model).toBeUndefined();
    expect(config.provider).toBeUndefined();
    expect(config.thinking).toBe('high');
  });

  it('still applies the workspace default model to a hosted run', async () => {
    const { service, created } = build({
      executors: [fakeExecutor('hosted'), fakeExecutor('local')],
      preferences: {
        agentRuns: { model: { provider: 'openai', model: 'gpt-5' } },
      },
    });

    await service.delegate({ ...delegateInput, executor: 'hosted' });

    expect(
      (created[0] as { config: Record<string, unknown> }).config,
    ).toMatchObject({ provider: 'openai', model: 'gpt-5' });
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
      executors: [fakeExecutor('one'), fakeExecutor('elsewhere')],
    });

    await expect(service.delegate(delegateInput)).rejects.toThrow(/name one/);
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
    const { service, agentRuns, created } = build({
      executors: [
        fakeExecutor('hosted', {
          dispatch: async () => {
            throw new Error('sandbox host unreachable');
          },
        }),
      ],
    });

    await service.delegate(delegateInput);

    // The run delegation opened, under the id it chose for it.
    const [{ id }] = created as Array<{ id: string }>;
    expect(agentRuns.transition).toHaveBeenCalledWith(
      id,
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

    expect(
      (created[0] as { config: Record<string, unknown> }).config,
    ).not.toHaveProperty('phases');
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

describe('AgentDelegationService knowledge arm', () => {
  it('[KG-3.3] chooses the arm from the id the run is created with, and stores it on the run', async () => {
    const { service, created, contextPacks } = build();

    await service.delegate(delegateInput);

    const [run] = created as Array<{ id: string; knowledgeArm: string }>;
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.knowledgeArm).toBe(knowledgeArmFor(run.id, 0.1));
    // The pack was built for that arm, before the row existed.
    expect(contextPacks.buildTraced).toHaveBeenCalledWith(
      ISSUE,
      WORKSPACE,
      undefined,
      undefined,
      run.knowledgeArm,
    );
  });

  it('[KG-3.3] holds out the share the workspace sets, over the deployment’s', async () => {
    const original = process.env.KNOWLEDGE_HOLDOUT_RATE;

    try {
      process.env.KNOWLEDGE_HOLDOUT_RATE = '1';
      const held = build();
      await held.service.delegate(delegateInput);
      expect(held.created[0]).toMatchObject({ knowledgeArm: 'HOLDOUT' });

      // A workspace that sets its own rate is held to it.
      const treated = build({ preferences: { knowledge: { holdoutRate: 0 } } });
      await treated.service.delegate(delegateInput);
      expect(treated.created[0]).toMatchObject({ knowledgeArm: 'TREATMENT' });
    } finally {
      if (original === undefined) {
        delete process.env.KNOWLEDGE_HOLDOUT_RATE;
      } else {
        process.env.KNOWLEDGE_HOLDOUT_RATE = original;
      }
    }
  });

  it('[KG-3.1] records what the run was packed, and how it was chosen, once the run exists', async () => {
    const { service, agentRuns, contextPacks } = build();

    await service.delegate(delegateInput);

    const run = await (agentRuns.createRun as jest.Mock).mock.results[0].value;
    expect(contextPacks.recordServed).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ tokenBudget: 1500, candidates: [] }),
    );
  });

  it('[KG-3.1] records the pack again for a retry, which is handed it too', async () => {
    const { service, contextPacks } = build();

    await service.retry('run-1', { workspaceId: WORKSPACE }, 'user-1');

    expect(contextPacks.recordServed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1-next' }),
    );
  });
});

/**
 * A run that exists and was never handed to a backend is the worst of both
 * worlds: it holds a slot against the concurrency cap, blocks its own issue
 * from being delegated again, and reads in the runs list as work in progress.
 * That is what every retry was while `createRun` alone counted as a dispatch.
 */
describe('AgentDelegationService retry', () => {
  it('starts the attempt it opens', async () => {
    const executor = fakeExecutor('hosted');
    const { service } = build({ executors: [executor] });

    const next = await service.retry(
      'run-1',
      { workspaceId: WORKSPACE },
      'user-1',
    );

    expect(next).toMatchObject({ id: 'run-1-next', attempt: 2 });
    expect(executor.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1-next' }),
    );
  });

  it('records a dispatch failure on the new attempt rather than dropping it', async () => {
    const { service, agentRuns } = build({
      executors: [
        fakeExecutor('hosted', {
          dispatch: async () => {
            throw new Error('sandbox host unreachable');
          },
        }),
      ],
    });

    await service.retry('run-1', { workspaceId: WORKSPACE }, 'user-1');

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1-next',
      'FAILED',
      expect.objectContaining({ failure: 'ENVIRONMENT_SETUP_FAILED' }),
    );
  });

  it('sends it to the backend the previous attempt used', async () => {
    // Not re-resolved. A workspace that changed its default between attempts
    // would otherwise retry on a backend the first attempt never ran on, and
    // the two would not be comparable.
    const hosted = fakeExecutor('hosted');
    const elsewhere = fakeExecutor('elsewhere');
    const { service } = build({ executors: [elsewhere, hosted] });

    await service.retry('run-1', { workspaceId: WORKSPACE }, 'user-1');

    expect(elsewhere.dispatch).toHaveBeenCalled();
    expect(hosted.dispatch).not.toHaveBeenCalled();
  });
});

/**
 * Moving the row is not stopping the work. Left to the lease renewal, a
 * cancelled sandbox runs on for up to a third of a lease before it notices.
 */
describe('AgentDelegationService cancel', () => {
  it('stops the executor as well as the row', async () => {
    const executor = fakeExecutor('hosted');
    const { service } = build({ executors: [executor] });

    const run = await service.cancel('run-1', { workspaceId: WORKSPACE });

    expect(run).toMatchObject({ id: 'run-1', status: 'CANCELED' });
    expect(executor.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1' }),
    );
  });

  it('keeps the cancel when the executor cannot stop the run', async () => {
    // The row is already CANCELED. A sandbox that is already gone must not
    // turn the cancel the person asked for into an error.
    const { service } = build({
      executors: [
        fakeExecutor('hosted', {
          cancel: async () => {
            throw new Error('sandbox already disposed');
          },
        }),
      ],
    });

    await expect(
      service.cancel('run-1', { workspaceId: WORKSPACE }),
    ).resolves.toMatchObject({ status: 'CANCELED' });
  });
});

describe('AgentDelegationService liveness', () => {
  it('counts only the statuses a run is really working in', async () => {
    // What lets an expired run go. EXPIRED, FAILED and the rest are terminal,
    // so the slot they held is released and the issue can be delegated again
    // — but only because neither guard reads them as live.
    const { service, prisma } = build();

    await service.delegate(delegateInput);

    const live = ['QUEUED', 'CLAIMED', 'RUNNING'];

    expect(
      (prisma.agentRun.findFirst as jest.Mock).mock.calls[0][0].where.status,
    ).toEqual({ in: live });
    expect(
      (prisma.agentRun.count as jest.Mock).mock.calls[0][0].where.status,
    ).toEqual({ in: live });
  });
});
