import type { ConnectorHello } from '@vantikhq/types';
import type { AgentRun } from '@prisma/client';
import type { PrismaService } from 'nestjs-prisma';

import { CONNECTOR_PROTOCOL_VERSION } from '@vantikhq/types';

import { ConnectorRegistry } from 'modules/connector/connector.registry';
import type { GitSourcesService } from 'modules/git/git-sources.service';

import type { AgentRunsService } from '../agent-runs.service';
import type { RunHandbackService } from '../run-handback.service';
import type { RunOutboxService } from '../run-outbox';
import type { RunTokensService } from '../run-tokens.service';
import { ExecutorRegistry } from './executor.registry';
import { LocalExecutor, scrubDeep } from './local.executor';

/**
 * The local executor: whose machine counts as available, what is sent to it,
 * and that a message the connector retries is recorded once.
 */

const WORKSPACE = 'ws-1';
const ME = 'user-1';
const COLLEAGUE = 'user-2';
const PERSON = { workspaceId: WORKSPACE, userId: ME };

const hello = (over: Partial<ConnectorHello> = {}): ConnectorHello => ({
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  connectorVersion: '0.1.0',
  hostname: 'laptop',
  ompVersion: '18.8.6',
  ompAgentDir: true,
  ...over,
});

const MODEL = {
  provider: 'openai-codex',
  id: 'gpt-6.1-sol',
  name: 'GPT 6.1 Sol',
  reasoning: true,
  thinkingLevels: ['low', 'high'],
};

function online(
  registry: ConnectorRegistry,
  userId: string,
  over: Partial<ConnectorHello> = {},
) {
  const emitWithAck = jest.fn().mockResolvedValue({ ok: true });
  const socket = { id: `socket-${userId}`, emitWithAck, disconnect: jest.fn() };

  registry.add({
    peer: { workspaceId: WORKSPACE, userId },
    hello: hello(over),
    socket,
    connectedAt: new Date(),
  });

  return { emitWithAck, socket };
}

const pack = {
  version: 1,
  issue: {
    id: 'issue-1',
    key: 'ENG-5',
    title: 'Fix it',
    description: 'Fix the thing properly.',
  },
  definitionOfDone: [{ id: 'c1', body: 'It works', completed: false }],
  repo: { pathPrefixes: ['apps/server'] },
};

function makeRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    workspaceId: WORKSPACE,
    issueId: 'issue-1',
    agentUserId: 'agent-1',
    createdById: ME,
    executor: 'local',
    status: 'QUEUED',
    attempt: 1,
    config: {
      source: { integrationAccountId: 'acct-1', externalRepoId: 'repo-1' },
      baseBranch: 'main',
      model: 'gpt-5',
      provider: 'openai',
      thinking: 'high',
    },
    contextPack: pack,
    ...over,
  } as unknown as AgentRun;
}

function build(
  repo: { slug: string; path?: string } = {
    slug: 'local-repo',
    path: '/src/app',
  },
) {
  const connectors = new ConnectorRegistry();

  const agentRuns = {
    transition: jest.fn().mockResolvedValue({}),
    appendEvent: jest.fn().mockResolvedValue({}),
    recordSpend: jest.fn().mockResolvedValue(undefined),
    renewLease: jest.fn().mockResolvedValue(true),
    recordExternalSession: jest.fn().mockResolvedValue(undefined),
  };
  const tokens = {
    personalAgentFor: jest.fn().mockResolvedValue('agent-1'),
    mint: jest.fn().mockResolvedValue({
      value: 'tg_pat_secrettoken',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
  const gitSources = {
    resolve: jest.fn().mockResolvedValue({
      source: { slug: repo.slug, defaultBranch: jest.fn() },
      repo: {
        externalRepoId: 'repo-1',
        fullName: 'me/app',
        listing: repo.path ? { path: repo.path } : {},
      },
    }),
  };
  const handback = { post: jest.fn().mockResolvedValue(undefined) };
  const outbox = {
    apply: jest.fn().mockResolvedValue({ applied: [], failed: [] }),
    tickCriteria: jest.fn().mockResolvedValue({ applied: [], failed: [] }),
  };
  const prisma = {
    usersOnWorkspaces: {
      findFirst: jest.fn().mockResolvedValue({
        settings: { agent: { ownership: 'personal', ownerUserId: ME } },
      }),
    },
    agentRun: { findFirst: jest.fn().mockResolvedValue(null) },
  };

  const executor = new LocalExecutor(
    new ExecutorRegistry(),
    connectors,
    agentRuns as unknown as AgentRunsService,
    gitSources as unknown as GitSourcesService,
    handback as unknown as RunHandbackService,
    outbox as unknown as RunOutboxService,
    tokens as unknown as RunTokensService,
    prisma as unknown as PrismaService,
  );

  return {
    executor,
    connectors,
    agentRuns,
    tokens,
    gitSources,
    handback,
    prisma,
  };
}

describe('LocalExecutor availability', () => {
  it('needs a person', async () => {
    const { executor } = build();

    await expect(
      executor.availability({ workspaceId: WORKSPACE }),
    ).resolves.toMatchObject({ available: false });
  });

  it('tells a person with no connector to run vantik connect', async () => {
    const { executor } = build();

    const result = await executor.availability(PERSON);

    expect(result).toMatchObject({ available: false });
    expect(result.available === false && result.reason).toMatch(
      /Run `vantik connect`/,
    );
  });

  it('is available when their own connector is online with omp', async () => {
    const { executor, connectors } = build();
    online(connectors, ME);

    await expect(executor.availability(PERSON)).resolves.toEqual({
      available: true,
      models: [],
      defaultModel: null,
    });
  });

  it('offers the models of the person’s own omp', async () => {
    const { executor, connectors } = build();
    online(connectors, ME, {
      models: [MODEL],
      defaultModel: 'openai-codex/gpt-6.1-sol',
    });

    await expect(executor.availability(PERSON)).resolves.toEqual({
      available: true,
      models: [MODEL],
      defaultModel: 'openai-codex/gpt-6.1-sol',
    });
  });

  it('does not count a colleague’s connector', async () => {
    const { executor, connectors } = build();
    online(connectors, COLLEAGUE);

    await expect(executor.availability(PERSON)).resolves.toMatchObject({
      available: false,
    });
    await expect(
      executor.availability({ workspaceId: WORKSPACE, userId: COLLEAGUE }),
    ).resolves.toMatchObject({ available: true });
  });

  it('is not available in another workspace', async () => {
    const { executor, connectors } = build();
    online(connectors, ME);

    await expect(
      executor.availability({ workspaceId: 'ws-other', userId: ME }),
    ).resolves.toMatchObject({ available: false });
  });

  it('is unavailable when the connector found no omp, and says where', async () => {
    const { executor, connectors } = build();
    online(connectors, ME, { ompVersion: null });

    const result = await executor.availability(PERSON);

    expect(result).toMatchObject({ available: false });
    expect(result.available === false && result.reason).toMatch(
      /omp is not installed on laptop/,
    );
  });

  it('is unavailable again once the connector goes', async () => {
    const { executor, connectors } = build();
    const { socket } = online(connectors, ME);

    connectors.remove(PERSON, socket.id);

    await expect(executor.availability(PERSON)).resolves.toMatchObject({
      available: false,
    });
  });

  it('attributes a run to the person’s personal agent', async () => {
    const { executor, tokens } = build();

    await expect(executor.runIdentity(PERSON)).resolves.toBe('agent-1');
    expect(tokens.personalAgentFor).toHaveBeenCalledWith(WORKSPACE, ME);
  });
});

describe('LocalExecutor dispatch', () => {
  it('sends the run to the connector with a run token and a local branch', async () => {
    const { executor, connectors, agentRuns, tokens } = build();
    const { emitWithAck } = online(connectors, ME);

    await executor.dispatch(makeRun());

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'CLAIMED',
      expect.anything(),
    );
    expect(tokens.mint).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', agentUserId: 'agent-1' }),
    );

    const [event, dispatch] = emitWithAck.mock.calls[0];
    expect(event).toBe('run.dispatch');
    expect(dispatch).toMatchObject({
      runId: 'run-1',
      issue: { key: 'ENG-5' },
      branch: 'agent/eng-5',
      repo: { path: '/src/app', fullName: 'me/app', baseRef: 'main' },
      model: { provider: 'openai', model: 'gpt-5', thinking: 'high' },
      token: { value: 'tg_pat_secrettoken' },
      policy: { pathPrefixes: ['apps/server'] },
    });
    // The paths are the connector's to fill in.
    expect(dispatch.policy).not.toHaveProperty('repoRoot');
    expect(dispatch.policy).not.toHaveProperty('outboxPath');
    expect(dispatch.prompt).toContain('ENG-5');
  });

  it('never writes the token to a run event', async () => {
    const { executor, connectors, agentRuns } = build();
    online(connectors, ME);

    await executor.dispatch(makeRun());

    expect(JSON.stringify(agentRuns.appendEvent.mock.calls)).not.toContain(
      'secrettoken',
    );
    expect(JSON.stringify(agentRuns.transition.mock.calls)).not.toContain(
      'secrettoken',
    );
  });

  it('fails the run, saying why, when the repository is not a local one', async () => {
    const { executor, connectors, agentRuns } = build({ slug: 'github' });
    const { emitWithAck } = online(connectors, ME);

    await executor.dispatch(makeRun());

    expect(emitWithAck).not.toHaveBeenCalled();
    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({
        failure: 'ENVIRONMENT_SETUP_FAILED',
        error: expect.stringMatching(/not a local repository/),
      }),
    );
  });

  it('fails fast when the person’s omp has no such model', async () => {
    const { executor, connectors, agentRuns } = build();
    const { emitWithAck } = online(connectors, ME, { models: [MODEL] });

    await executor.dispatch(makeRun());

    expect(emitWithAck).not.toHaveBeenCalled();
    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({
        error: expect.stringMatching(
          /Your omp setup has no model openai\/gpt-5/,
        ),
      }),
    );
  });

  it('sends a model the person’s omp has', async () => {
    const { executor, connectors } = build();
    const { emitWithAck } = online(connectors, ME, { models: [MODEL] });

    await executor.dispatch(
      makeRun({
        config: {
          ...(makeRun().config as object),
          provider: 'openai-codex',
          model: 'gpt-6.1-sol',
        },
      }),
    );

    expect(emitWithAck).toHaveBeenCalledWith(
      'run.dispatch',
      expect.objectContaining({
        model: expect.objectContaining({ model: 'gpt-6.1-sol' }),
      }),
      expect.anything(),
    );
  });

  it('leaves omp’s default alone when no model is chosen', async () => {
    const { executor, connectors, agentRuns } = build();
    const { emitWithAck } = online(connectors, ME, { models: [MODEL] });

    await executor.dispatch(
      makeRun({
        config: {
          source: { integrationAccountId: 'acct-1', externalRepoId: 'repo-1' },
          baseBranch: 'main',
        },
      }),
    );

    expect(emitWithAck).toHaveBeenCalled();
    expect(agentRuns.transition).not.toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.anything(),
    );
  });

  it('fails the run when the issue names no repository', async () => {
    const { executor, connectors, agentRuns } = build();
    online(connectors, ME);

    await executor.dispatch(makeRun({ config: {} }));

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({
        error: expect.stringMatching(/no repository to open/),
      }),
    );
  });

  it('fails the run when the connector refuses it, and ends the token', async () => {
    const { executor, connectors, agentRuns, tokens } = build();
    const { emitWithAck } = online(connectors, ME);
    emitWithAck.mockResolvedValue({ ok: false, reason: 'no worktree space' });

    await executor.dispatch(makeRun());

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({
        error: expect.stringMatching(/no worktree space/),
      }),
    );
    expect(tokens.revoke).toHaveBeenCalledWith('run-1');
  });
});

describe('LocalExecutor message idempotency', () => {
  const started = {
    runId: 'run-1',
    seq: 0,
    ompSessionId: 'omp-9',
    sessionFile: '/home/me/.omp/agent/sessions/9.jsonl',
    worktreePath: '/src/app-wt',
    branch: 'agent/eng-5',
    baseCommit: 'abc123',
  };
  const step = {
    type: 'tool_execution_start',
    toolName: 'read',
    toolCallId: 't1',
    args: { path: 'a.ts' },
  };

  async function running() {
    const made = build();
    online(made.connectors, ME);
    await made.executor.dispatch(makeRun());
    made.agentRuns.transition.mockClear();
    made.agentRuns.appendEvent.mockClear();
    return made;
  }

  it('records run.started once however often it is sent', async () => {
    const { executor, agentRuns } = await running();

    await expect(
      executor.handle(PERSON, 'run.started', started),
    ).resolves.toEqual({ ok: true });
    await expect(
      executor.handle(PERSON, 'run.started', started),
    ).resolves.toEqual({ ok: true });

    const moved = agentRuns.transition.mock.calls.filter(
      ([, status]) => status === 'RUNNING',
    );
    expect(moved).toHaveLength(1);
    expect(agentRuns.recordExternalSession).toHaveBeenCalledTimes(1);
    expect(agentRuns.recordExternalSession).toHaveBeenCalledWith(
      'run-1',
      'omp-9',
    );
  });

  it('records a batch of events once, and an older seq not at all', async () => {
    const { executor, agentRuns } = await running();

    await executor.handle(PERSON, 'run.started', started);
    agentRuns.appendEvent.mockClear();

    const batch = { runId: 'run-1', seq: 1, events: [step] };
    await executor.handle(PERSON, 'run.events', batch);
    const first = agentRuns.appendEvent.mock.calls.length;
    expect(first).toBe(1);

    await executor.handle(PERSON, 'run.events', batch);
    await executor.handle(PERSON, 'run.events', { ...batch, seq: 0 });

    expect(agentRuns.appendEvent.mock.calls).toHaveLength(first);
  });

  it('handles messages sent together in the order they were sent', async () => {
    const { executor, agentRuns } = await running();

    const results = await Promise.all([
      executor.handle(PERSON, 'run.started', started),
      executor.handle(PERSON, 'run.events', {
        runId: 'run-1',
        seq: 1,
        events: [step],
      }),
      executor.handle(PERSON, 'run.started', started),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(
      agentRuns.transition.mock.calls.filter(([, to]) => to === 'RUNNING'),
    ).toHaveLength(1);
  });

  it('does not mark a message handled when recording it failed', async () => {
    const { executor, agentRuns } = await running();
    agentRuns.transition.mockRejectedValueOnce(new Error('db blip'));

    await expect(
      executor.handle(PERSON, 'run.started', started),
    ).resolves.toMatchObject({ ok: false });

    // The connector retries the same seq, and this time it is recorded.
    await expect(
      executor.handle(PERSON, 'run.started', started),
    ).resolves.toEqual({ ok: true });
    expect(agentRuns.recordExternalSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a message about another person’s run', async () => {
    const { executor } = await running();

    await expect(
      executor.handle(
        { workspaceId: WORKSPACE, userId: COLLEAGUE },
        'run.started',
        started,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'That run is not yours.' });
  });

  it('refuses a message with no run id or seq', async () => {
    const { executor } = await running();

    await expect(
      executor.handle(PERSON, 'run.events', { events: [] }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('acknowledges a message for a run that already ended', async () => {
    const { executor, prisma } = build();
    prisma.agentRun.findFirst.mockResolvedValue({
      status: 'CANCELED',
      executor: 'local',
    });

    await expect(
      executor.handle(PERSON, 'run.finished', {
        runId: 'run-9',
        seq: 4,
        outcome: 'cancelled',
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('records a successful finish as SUCCEEDED and hands back the local branch', async () => {
    const { executor, agentRuns, handback, tokens } = await running();
    await executor.handle(PERSON, 'run.started', started);
    agentRuns.transition.mockClear();

    await executor.handle(PERSON, 'run.finished', {
      runId: 'run-1',
      seq: 1,
      outcome: 'succeeded',
      summary: 'Fixed it.',
      branch: 'agent/eng-5',
      headCommit: 'def456',
      error: null,
    });

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'SUCCEEDED',
      expect.objectContaining({
        summary: 'Fixed it.',
        result: expect.objectContaining({
          branch: 'agent/eng-5',
          worktreePath: '/src/app-wt',
        }),
      }),
    );
    expect(handback.post).toHaveBeenCalledWith(
      'issue-1',
      'agent-1',
      'run-1',
      expect.objectContaining({
        status: 'SUCCEEDED',
        branch: 'agent/eng-5',
        worktreePath: '/src/app-wt',
      }),
    );
    expect(tokens.revoke).toHaveBeenCalledWith('run-1');
  });

  it('fails a finish that changed nothing', async () => {
    const { executor, agentRuns } = await running();
    await executor.handle(PERSON, 'run.started', started);
    agentRuns.transition.mockClear();

    await executor.handle(PERSON, 'run.finished', {
      runId: 'run-1',
      seq: 1,
      outcome: 'succeeded',
      summary: null,
      branch: null,
      headCommit: null,
      error: null,
    });

    expect(agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({ failure: 'NO_DIFF_PRODUCED' }),
    );
  });
});

describe('LocalExecutor connector loss', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fails a run whose connector does not come back within the grace period', async () => {
    const made = build();
    const { socket } = online(made.connectors, ME);
    await made.executor.dispatch(makeRun());
    made.agentRuns.transition.mockClear();

    made.connectors.remove(PERSON, socket.id);
    // The handler is set by onModuleInit in a real app.
    made.executor.disconnected(PERSON);

    await jest.advanceTimersByTimeAsync(119_000);
    expect(made.agentRuns.transition).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2_000);
    expect(made.agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({
        error: expect.stringMatching(/did not come back/),
      }),
    );
  });

  it('keeps a run whose connector returns in time', async () => {
    const made = build();
    const { socket } = online(made.connectors, ME);
    await made.executor.dispatch(makeRun());
    made.agentRuns.transition.mockClear();

    made.connectors.remove(PERSON, socket.id);
    made.executor.disconnected(PERSON);
    await jest.advanceTimersByTimeAsync(60_000);
    made.executor.connected(PERSON, hello());
    await jest.advanceTimersByTimeAsync(180_000);

    expect(made.agentRuns.transition).not.toHaveBeenCalled();
  });

  it('fails a run that reaches its deadline', async () => {
    const made = build();
    online(made.connectors, ME);
    await made.executor.dispatch(
      makeRun({
        config: {
          source: { integrationAccountId: 'a', externalRepoId: 'repo-1' },
          limits: { maxDurationMs: 60_000 },
        },
      }),
    );
    made.agentRuns.transition.mockClear();

    await jest.advanceTimersByTimeAsync(61_000);

    expect(made.agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({ failure: 'BUDGET_EXHAUSTED' }),
    );
  });
});

describe('LocalExecutor reconnect with a list of runs', () => {
  async function tracked() {
    const made = build();
    online(made.connectors, ME);
    await made.executor.dispatch(makeRun());
    made.agentRuns.transition.mockClear();
    return made;
  }

  it('fails a tracked run the connector no longer lists', async () => {
    const made = await tracked();

    made.executor.connected(PERSON, hello({ activeRunIds: [] }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(made.agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({ failure: 'HARNESS_CRASHED' }),
    );
  });

  it('keeps a run the connector lists, or one from a connector that lists nothing', async () => {
    const made = await tracked();

    made.executor.connected(PERSON, hello({ activeRunIds: ['run-1'] }));
    made.executor.connected(PERSON, hello());
    await new Promise((resolve) => setImmediate(resolve));

    expect(made.agentRuns.transition).not.toHaveBeenCalled();
  });

  it('fails the runs of a replaced socket whose new connector does not know them', async () => {
    const made = await tracked();
    made.connectors.setHandler(made.executor);

    online(made.connectors, ME, { activeRunIds: [] });
    await new Promise((resolve) => setImmediate(resolve));

    expect(made.agentRuns.transition).toHaveBeenCalledWith(
      'run-1',
      'FAILED',
      expect.objectContaining({ failure: 'HARNESS_CRASHED' }),
    );
  });
});

describe('LocalExecutor untracked runs and secrets', () => {
  it('starts the reason for a live run it lost with "untracked:"', async () => {
    const { executor, prisma } = build();
    prisma.agentRun.findFirst.mockResolvedValue({
      status: 'RUNNING',
      executor: 'local',
    });

    const ack = await executor.handle(PERSON, 'run.events', {
      runId: 'run-1',
      seq: 3,
      events: [],
    });

    expect(ack).toMatchObject({ ok: false });
    expect(ack.ok === false && ack.reason).toMatch(/^untracked:/);
  });

  it('keeps the run token out of step data, however deep', async () => {
    const made = build();
    online(made.connectors, ME);
    await made.executor.dispatch(makeRun());
    made.agentRuns.appendEvent.mockClear();

    await made.executor.handle(PERSON, 'run.events', {
      runId: 'run-1',
      seq: 1,
      events: [
        {
          type: 'tool_execution_start',
          toolName: 'bash',
          toolCallId: 't1',
          args: {
            command: 'curl -H "Authorization: Bearer tg_pat_secrettoken"',
          },
        },
        {
          type: 'tool_execution_end',
          toolName: 'bash',
          toolCallId: 't1',
          result: { content: [{ type: 'text', text: 'tg_pat_secrettoken' }] },
        },
      ],
    });

    expect(made.agentRuns.appendEvent).toHaveBeenCalled();
    expect(JSON.stringify(made.agentRuns.appendEvent.mock.calls)).not.toContain(
      'secrettoken',
    );
  });

  it('scrubs every string in a nested value', () => {
    const out = JSON.stringify(
      scrubDeep(
        { a: ['x tg_pat_secrettoken', { b: 'tg_pat_secrettoken' }], n: 1 },
        ['tg_pat_secrettoken'],
      ),
    );

    expect(out).not.toContain('secrettoken');
    expect(out).toContain('"n":1');
  });
});
