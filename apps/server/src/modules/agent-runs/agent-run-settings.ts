import type { AgentRunRepoConfig } from '@vantikhq/types';

import { agentSettings } from 'modules/auth/agent-scope';

/**
 * Per-workspace agent defaults, read out of `Workspace.preferences`.
 *
 * A JSON blob rather than columns because this is configuration a deployment
 * tunes, not data anything queries by. Read through here rather than off the
 * JSON directly, so there is one place that knows what shape it is and one
 * place that decides what happens when it is absent or malformed — which,
 * being free-form JSON someone may have hand-edited, it will occasionally be.
 */
export interface WorkspaceAgentDefaults {
  /** Executor key used when neither the request nor the agent names one. */
  defaultExecutor: string | null;
  repo: AgentRunRepoConfig;
  /**
   * Which ENG-62 phases the workspace runs. Absent means none, and none is
   * the shipped default: the null hypothesis is that implement plus
   * deterministic verification is as good, and every phase has to earn its
   * place against that.
   */
  phases: {
    specify?: boolean;
    score?: boolean;
    review?: boolean;
  };
}

export function workspaceAgentDefaults(
  preferences: unknown,
): WorkspaceAgentDefaults {
  const agentRuns = (
    preferences as { agentRuns?: Partial<WorkspaceAgentDefaults> } | null
  )?.agentRuns;

  return {
    defaultExecutor: agentRuns?.defaultExecutor ?? null,
    repo: isObject(agentRuns?.repo) ? agentRuns.repo : {},
    phases: isObject(agentRuns?.phases) ? agentRuns.phases : {},
  };
}

/**
 * The executor an agent account is bound to, if any.
 *
 * Lives beside ownership and scopes in the membership's agent settings, so an
 * agent provisioned for a particular runner reaches that runner without the
 * delegating caller having to know which one it is.
 */
export function agentBoundExecutor(settings: unknown): string | null {
  const agent = (settings as { agent?: { executor?: unknown } } | null)?.agent;

  return typeof agent?.executor === 'string' && agent.executor
    ? agent.executor
    : null;
}

/** Re-exported so callers reading agent settings have one import, not two. */
export { agentSettings };

function isObject(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
