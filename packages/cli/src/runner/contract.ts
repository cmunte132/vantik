import type { AgentRunFailure } from './failures';

/**
 * The harness contract.
 *
 * A harness is whatever actually drives a model against a checkout. Pi is the
 * one that ships, but the daemon knows nothing about it beyond this interface,
 * so pointing `--harness` at something else is a configuration change rather
 * than a code change.
 *
 * ## What a harness receives
 *
 * A {@link HarnessRequest}: the context pack the server assembled (issue,
 * Definition of Done, comments, relations), the absolute path of a checkout
 * that is already prepared and on the right branch, and the repo's own
 * verification commands. It does not receive credentials — the runner holds
 * those and the harness inherits only what the runner chooses to pass through
 * its environment.
 *
 * ## What a harness must emit
 *
 * Progress via the `onEvent` callback as it goes. These become AgentRunEvent
 * rows, so they should be phase-boundary-shaped ("running tests", "3 files
 * changed") rather than a raw transcript dump. Only the harness knows where
 * its phases begin, which is why this is its responsibility and not the
 * daemon's.
 *
 * ## How a harness signals outcome
 *
 * By returning a {@link HarnessResult}, never by exit code alone:
 *
 * - `outcome: 'changed'` — it did work. The daemon computes the patch itself.
 * - `outcome: 'no-op'` — it ran and deliberately changed nothing.
 * - `outcome: 'failed'` — with a typed `failure` the user can act on.
 *
 * A harness must never report the patch itself. The daemon computes it as
 * `git diff` against the recorded base commit, because asking a model to emit
 * a unified diff measured 19.1% against 73.4% for the same model — a gap that
 * is line numbers, hunk headers and trailing newlines rather than intelligence.
 */
export interface HarnessRequest {
  /** Absolute path to the prepared checkout. Already on the work branch. */
  workdir: string;
  /** The commit the patch will be computed against. Recorded before any edit. */
  baseCommit: string;
  /** What the server assembled about the issue. Shape owned by the server. */
  contextPack: ContextPack;
  /** How to verify a change in this repository. */
  verification: VerificationCommands;
  limits: HarnessLimits;
  /** Progress out. Called as work happens, not batched at the end. */
  onEvent: (event: HarnessEvent) => void;
  /** Aborts the run — budget exhausted, lease lost, or cancelled upstream. */
  signal: AbortSignal;
}

/** Just enough of the server's pack for a harness to write a prompt. */
export interface ContextPack {
  issue: {
    key: string;
    title: string;
    description: string;
    labels?: string[];
    url?: string | null;
  };
  definitionOfDone?: Array<{ body: string; completed: boolean }>;
  subTasks?: Array<{ key: string; title: string; done: boolean }>;
  relations?: Array<{ type: string; key: string; title: string }>;
  comments?: Array<{ author: string | null; at: string; body: string }>;
  knowledge?: Array<{ scope: string; body: string }>;
}

export interface VerificationCommands {
  test?: string;
  lint?: string;
  typecheck?: string;
  build?: string;
}

export interface HarnessLimits {
  maxDurationMs?: number;
  maxTokens?: number;
  maxIterations?: number;
  /** Dollars, from the usage the provider reports. See `budget.ts`. */
  maxCostUsd?: number;
}

export interface HarnessEvent {
  level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  /** Which phase this belongs to: `setup`, `implement`, `verify`, `report`. */
  phase?: string;
  data?: Record<string, unknown>;
}

export interface HarnessResult {
  outcome: 'changed' | 'no-op' | 'failed';
  /** Prose for a human. The server renders the issue comment from this. */
  summary?: string;
  /** Required when `outcome` is `failed`. */
  failure?: AgentRunFailure;
  error?: string;
  /** Recorded on the run so two runs are comparable. */
  harnessVersion?: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  iterationCount?: number;
}

/**
 * What the daemon calls. One method, so an alternative harness is a single
 * function rather than a class hierarchy.
 */
export interface Harness {
  readonly name: string;
  /** Pinned build, recorded on every run alongside the model id. */
  version(): Promise<string>;
  run(request: HarnessRequest): Promise<HarnessResult>;
}
