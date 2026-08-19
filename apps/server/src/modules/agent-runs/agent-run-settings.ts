import {
  THINKING_LEVELS,
  isSafeModelId,
  type AgentRunLimits,
  type AgentRunPhases,
  type AgentRunRepoConfig,
  type ModelChoice,
  type ThinkingLevel,
} from '@vantikhq/types';

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
   * What runs pick up when the person delegating does not say.
   *
   * A workspace default rather than a per-run requirement because most runs
   * should not be a decision. Somebody configures a key, picks a model once,
   * and delegating is a single click after that — the per-run override exists
   * for the issue where the default is the wrong trade, not for every issue.
   */
  model: ModelChoice;
  /**
   * Which review phases the workspace runs.
   *
   * Absent means "not stated", which is not the same as off — each executor
   * decides what an unstated flag means for it. `specify` and `score` belong
   * to the BYO runner's loop and default off there, because the null
   * hypothesis is that implement plus deterministic verification is as good.
   * `review` is the hosted sandbox's implement → verify → review → revise
   * cycle and defaults on, because a diff nothing has read is the failure that
   * whole executor is arranged to prevent.
   */
  phases: AgentRunPhases;
  /**
   * What a run may spend before somebody has to look at it.
   *
   * A workspace-level setting because the cost of agent work lands on whoever
   * holds the model key, and they are not the person clicking delegate. A run
   * may still be given its own ceilings; these are what applies when it is not.
   */
  limits: AgentRunLimits;
}

export function workspaceAgentDefaults(
  preferences: unknown,
): WorkspaceAgentDefaults {
  const agentRuns = (
    preferences as { agentRuns?: Partial<WorkspaceAgentDefaults> } | null
  )?.agentRuns;

  return {
    defaultExecutor: executorKeyOf(agentRuns?.defaultExecutor),
    repo: isObject(agentRuns?.repo) ? agentRuns.repo : {},
    model: modelChoiceOf(agentRuns?.model),
    phases: phaseFlagsOf(agentRuns?.phases),
    limits: limitsOf(agentRuns?.limits),
  };
}

/**
 * Limit fields that must be integers (counts and durations).
 *
 * `maxCostUsd` is intentionally absent: spending $1.50 is meaningful, so
 * decimal budgets are valid.
 */
const INTEGER_LIMIT_NAMES = [
  'maxDurationMs',
  'maxTokens',
  'maxIterations',
  'maxCycles',
] as const;

/**
 * Stored ceilings, read back one field at a time.
 *
 * Anything that is not a positive, finite number is dropped rather than passed
 * through. A `0` or a `"5"` reaching the run would be a ceiling nothing can
 * satisfy or a comparison against a string, and both surface as a run that
 * stops immediately for a reason nobody can find.
 */
function limitsOf(value: unknown): AgentRunLimits {
  if (!isObject(value)) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const limits: AgentRunLimits = {};

  for (const name of INTEGER_LIMIT_NAMES) {
    const entry = raw[name];

    if (
      typeof entry === 'number' &&
      Number.isFinite(entry) &&
      entry > 0 &&
      Number.isInteger(entry)
    ) {
      limits[name] = entry;
    }
  }

  const costEntry = raw['maxCostUsd'];
  if (
    typeof costEntry === 'number' &&
    Number.isFinite(costEntry) &&
    costEntry > 0
  ) {
    limits['maxCostUsd'] = costEntry;
  }

  return limits;
}

const PHASE_NAMES = ['specify', 'score', 'review'] as const;

/**
 * Stored phase switches, read back with each flag's type checked.
 *
 * Dropping a value of the wrong type rather than passing it through is the
 * whole point. These are spread over the runner's defaults, so a stored
 * `"false"` — a string, and every non-empty string is truthy — would turn a
 * phase *on* to say that it is off. A flag that is dropped falls back to the
 * default instead, which is what an unreadable value should do.
 */
function phaseFlagsOf(value: unknown): WorkspaceAgentDefaults['phases'] {
  if (!isObject(value)) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const phases: WorkspaceAgentDefaults['phases'] = {};

  for (const name of PHASE_NAMES) {
    if (typeof raw[name] === 'boolean') {
      phases[name] = raw[name] as boolean;
    }
  }

  return phases;
}

/**
 * An executor key, which is a registry lookup rather than free text.
 *
 * Anything that is not a non-empty string reads back as absent, so the
 * registry is asked for an executor by name or is not asked at all.
 */
function executorKeyOf(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * A stored model choice, read back with every field checked.
 *
 * Free-form JSON that reaches a command line, so nothing is trusted: an
 * unknown thinking level would be rejected by Pi and kill the run, and a model
 * id outside the safe set has no legitimate form.
 */
function modelChoiceOf(value: unknown): ModelChoice {
  if (!isObject(value)) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const choice: ModelChoice = {};

  if (typeof raw.provider === 'string' && isSafeModelId(raw.provider)) {
    choice.provider = raw.provider;
  }
  if (typeof raw.model === 'string' && isSafeModelId(raw.model)) {
    choice.model = raw.model;
  }
  if (
    typeof raw.thinking === 'string' &&
    (THINKING_LEVELS as readonly string[]).includes(raw.thinking)
  ) {
    choice.thinking = raw.thinking as ThinkingLevel;
  }

  return choice;
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

  return executorKeyOf(agent?.executor);
}

/** Re-exported so callers reading agent settings have one import, not two. */
export { agentSettings };

function isObject(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
