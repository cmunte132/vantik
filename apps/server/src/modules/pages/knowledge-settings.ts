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

/**
 * Whether triage decides about new entries, and whether it acts on what it
 * decides. `shadow` decides and records, and changes nothing: the decisions
 * can be compared with what people decided before anyone lets it act.
 */
export type KnowledgeAutoTriage = 'off' | 'shadow' | 'on';

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
  /** `KNOWLEDGE_AUTO_TRIAGE`: off, shadow or on. */
  autoTriage: KnowledgeAutoTriage;
  /**
   * How alike two entries must be, from 0 to 1 (1 minus the index's vector
   * distance), before a model is asked how they relate. Below it they are
   * taken to be different facts without asking. The default is the distance
   * the write-time near-match check uses. `KNOWLEDGE_SIMILARITY_THRESHOLD`.
   */
  similarityThreshold: number;
  /**
   * The share of decisions triage acted on that a person is asked to check,
   * from 0 to 1. `KNOWLEDGE_AUDIT_RATE`.
   */
  auditRate: number;
  /**
   * The agreement, as Cohen's kappa from 0 to 1, below which a decision type
   * stops acting and escalates instead. `KNOWLEDGE_KAPPA_FLOOR`.
   */
  kappaFloor: number;
  /**
   * How many verdicts a decision type needs in the window before the floor
   * applies to it. `KNOWLEDGE_KAPPA_MIN_SAMPLES`.
   */
  kappaMinSamples: number;
  /** How many days of verdicts agreement is measured over. `KNOWLEDGE_KAPPA_WINDOW_DAYS`. */
  kappaWindowDays: number;
  /**
   * How many separate runs must be given the same review finding in a module
   * before the gardener proposes it as a convention there.
   * `KNOWLEDGE_CONVENTION_MIN_RUNS`.
   */
  conventionMinRuns: number;
  /**
   * How far a convention the gardener wrote may be behind, harmful outcomes
   * over helpful ones, before it is taken out of use.
   * `KNOWLEDGE_CONVENTION_HARM_MARGIN`.
   */
  conventionHarmMargin: number;
}

export const DEFAULT_KNOWLEDGE_SETTINGS: Readonly<KnowledgeSettings> = {
  holdoutRate: 0.1,
  contextTopK: 5,
  contextTokenBudget: 1_500,
  autoTriage: 'shadow',
  similarityThreshold: 0.25,
  auditRate: 0.1,
  kappaFloor: 0.6,
  kappaMinSamples: 20,
  kappaWindowDays: 30,
  conventionMinRuns: 3,
  conventionHarmMargin: 3,
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
    autoTriage:
      modeOf(stored.autoTriage) ??
      modeOf(env.KNOWLEDGE_AUTO_TRIAGE?.trim().toLowerCase()) ??
      DEFAULT_KNOWLEDGE_SETTINGS.autoTriage,
    similarityThreshold:
      shareOf(stored.similarityThreshold) ??
      shareOf(fromEnv(env.KNOWLEDGE_SIMILARITY_THRESHOLD)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.similarityThreshold,
    auditRate:
      shareOf(stored.auditRate) ??
      shareOf(fromEnv(env.KNOWLEDGE_AUDIT_RATE)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.auditRate,
    kappaFloor:
      shareOf(stored.kappaFloor) ??
      shareOf(fromEnv(env.KNOWLEDGE_KAPPA_FLOOR)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.kappaFloor,
    kappaMinSamples:
      countOf(stored.kappaMinSamples) ??
      countOf(fromEnv(env.KNOWLEDGE_KAPPA_MIN_SAMPLES)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.kappaMinSamples,
    kappaWindowDays:
      countOf(stored.kappaWindowDays) ??
      countOf(fromEnv(env.KNOWLEDGE_KAPPA_WINDOW_DAYS)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.kappaWindowDays,
    conventionMinRuns:
      countOf(stored.conventionMinRuns) ??
      countOf(fromEnv(env.KNOWLEDGE_CONVENTION_MIN_RUNS)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.conventionMinRuns,
    conventionHarmMargin:
      countOf(stored.conventionHarmMargin) ??
      countOf(fromEnv(env.KNOWLEDGE_CONVENTION_HARM_MARGIN)) ??
      DEFAULT_KNOWLEDGE_SETTINGS.conventionHarmMargin,
  };
}

const MODES: readonly KnowledgeAutoTriage[] = ['off', 'shadow', 'on'];

/**
 * A triage mode, or nothing. A stored mode is read as written, as the other
 * stored settings are; the environment's is read case-insensitively, as an
 * operator types it.
 */
function modeOf(value: unknown): KnowledgeAutoTriage | undefined {
  return MODES.find((mode) => mode === value);
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
