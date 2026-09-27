/**
 * The knowledge bank's settings for one workspace.
 *
 * Each has a default, an environment variable that sets it for the deployment,
 * and a key under `Workspace.preferences.knowledge` that sets it for one
 * workspace. Read through here rather than off either directly, so there is
 * one place that knows the names and one place that decides what an
 * unreadable value means — the same reasoning `agent-run-settings.ts` gives
 * for `preferences.agentRuns`. A value that cannot be read is dropped, and the
 * layer beneath it applies: a mistake in a setting is never read as "none" or
 * "all".
 */
export interface KnowledgeSettings {
  /**
   * The share of runs held out from the workspace's knowledge, from 0 (every
   * run is handed it) to 1 (none is). `KNOWLEDGE_HOLDOUT_RATE`.
   */
  holdoutRate: number;
  /**
   * How many relevant entries a run is handed beyond its modules'
   * conventions. Few on purpose: an agent does better with one relevant
   * memory than with four, and every item is read on every turn.
   * `KNOWLEDGE_CONTEXT_TOP_K`.
   */
  contextTopK: number;
  /** The tokens a run's knowledge may take. `KNOWLEDGE_CONTEXT_TOKEN_BUDGET`. */
  contextTokenBudget: number;
}

export const DEFAULT_KNOWLEDGE_SETTINGS: Readonly<KnowledgeSettings> = {
  holdoutRate: 0.1,
  contextTopK: 5,
  contextTokenBudget: 1_500,
};

/** The most tokens any knowledge budget allows, whatever is configured. */
export const MAX_KNOWLEDGE_TOKEN_BUDGET = 20_000;

/** The settings in force for a workspace with these preferences. */
export function knowledgeSettings(
  preferences: unknown,
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeSettings {
  const stored = storedSettings(preferences);

  return {
    holdoutRate:
      shareOf(stored.holdoutRate) ??
      shareOf(fromEnv(env.KNOWLEDGE_HOLDOUT_RATE)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.holdoutRate,
    contextTopK:
      countOf(stored.contextTopK) ??
      countOf(fromEnv(env.KNOWLEDGE_CONTEXT_TOP_K)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.contextTopK,
    contextTokenBudget: Math.min(
      countOf(stored.contextTokenBudget) ??
        countOf(fromEnv(env.KNOWLEDGE_CONTEXT_TOKEN_BUDGET)) ??
        DEFAULT_KNOWLEDGE_SETTINGS.contextTokenBudget,
      MAX_KNOWLEDGE_TOKEN_BUDGET,
    ),
  };
}

function storedSettings(preferences: unknown): Record<string, unknown> {
  const knowledge = isObject(preferences)
    ? (preferences as { knowledge?: unknown }).knowledge
    : undefined;

  return isObject(knowledge) ? (knowledge as Record<string, unknown>) : {};
}

/**
 * A variable as a number, or nothing when it is unset. Only the environment is
 * parsed: a stored preference is JSON, and a string where a number belongs is
 * a mistake to drop, not a number to guess at.
 */
function fromEnv(raw: string | undefined): number | undefined {
  return raw?.trim() ? Number(raw) : undefined;
}

function shareOf(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
