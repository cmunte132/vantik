import type { VantikClient } from '@vantikhq/agent-core';

import type { AgentRunFailure } from './failures';

/** The run row as a runner needs it. */
export interface ClaimedRun {
  id: string;
  issueId: string;
  attempt: number;
  executor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contextPack: any;
}

export interface ReportInput {
  failure?: AgentRunFailure;
  summary?: string;
  error?: string;
  delivery?: 'pull_request' | 'worktree';
  branch?: string;
  prUrl?: string;
  worktreePath?: string;
  headCommit?: string;
  baseCommit?: string;
  harnessVersion?: string;
  modelId?: string;
  counters?: Record<string, number>;
  phaseTimings?: Record<string, number>;
  iterationCount?: number;
  needsReview?: boolean;
}

/**
 * The runner's side of the claim/heartbeat/report protocol.
 *
 * Thin on purpose: the server owns the lifecycle, and every method here is one
 * request. Nothing is cached, because a runner that trusts its own idea of a
 * run's state is exactly the runner that reports on work the server already
 * expired.
 */
export class RunnerClient {
  constructor(private client: VantikClient) {}

  /** Asks for work. Null when the queue is empty. */
  async claim(executor?: string): Promise<ClaimedRun | null> {
    const run = await this.client.post<ClaimedRun | null>('/agent_runs/claim', {
      body: executor ? { executor } : {},
    });

    return run?.id ? run : null;
  }

  /**
   * Renews the lease.
   *
   * Throws when the run is no longer the runner's to work on — cancelled from
   * the UI, or expired and re-queued. That throw is how a runner finds out to
   * stop, so callers must not swallow it.
   */
  async heartbeat(runId: string): Promise<void> {
    await this.client.post(`/agent_runs/${runId}/heartbeat`, { body: {} });
  }

  async start(
    runId: string,
    input: { baseCommit?: string; harnessVersion?: string; modelId?: string },
  ): Promise<void> {
    await this.client.post(`/agent_runs/${runId}/start`, { body: input });
  }

  async event(
    runId: string,
    input: {
      message: string;
      level?: string;
      phase?: string;
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.client.post(`/agent_runs/${runId}/events`, { body: input });
  }

  /** Records one pass of the loop. Δ is computed server-side. */
  async iteration(
    runId: string,
    input: {
      index: number;
      validationPassRate?: number;
      heldOutPassRate?: number;
      verificationPassed?: boolean;
      findings?: unknown[];
      diffHash?: string;
      phaseTimings?: Record<string, number>;
    },
  ): Promise<void> {
    await this.client.post(`/agent_runs/${runId}/iterations`, { body: input });
  }

  async report(runId: string, input: ReportInput): Promise<void> {
    await this.client.post(`/agent_runs/${runId}/report`, { body: input });
  }
}
