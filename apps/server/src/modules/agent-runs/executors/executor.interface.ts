import type { AgentRun } from '@prisma/client';

/**
 * Why an executor cannot be used, when it cannot.
 *
 * A reason rather than a boolean, because every "you cannot use this" the
 * user sees has to say what to do about it. "The hosted executor is
 * unavailable" is a support ticket; "this workspace has no model credentials
 * configured" is a settings page.
 */
export type ExecutorAvailability =
  | { available: true }
  | { available: false; reason: string };

/**
 * A backend that can run an agent.
 *
 * Narrow on purpose — two methods — so a queue-based backend (the BYO runner,
 * which claims work when it is ready) and a push-based one (a hosted sandbox,
 * or a third-party coding agent poked by webhook) both fit without a special
 * case anywhere in the delegation layer. If the hosted path ever needs a
 * branch in the dispatcher, this interface is wrong.
 *
 * Adapters are registered, never switched on. The three-way provider switch in
 * the old LLM code is the cautionary example: it had to be torn out the moment
 * a fourth provider appeared, and GitHub coding agents and other vendors are
 * expected here as adapters later.
 */
export interface AgentExecutor {
  /** Registry key, stored on the run. `byo`, `hosted`, later `github`. */
  readonly key: string;

  /** Shown when a human picks an executor. */
  readonly label: string;

  /**
   * Whether this executor can take work in this deployment, for this
   * workspace, right now. Checked before a run is created rather than after,
   * so an unusable executor is a clear refusal instead of a run that sits
   * QUEUED for ever with nobody coming for it.
   */
  availability(workspaceId: string): Promise<ExecutorAvailability>;

  /**
   * Called once, after the run row exists.
   *
   * For a queue-based backend this is a no-op: the row *is* the dispatch, and
   * a runner will claim it. For a push-based backend this is where the work
   * actually starts. Either way a failure here must land as a visible state on
   * the run — never a dropped promise, which is what the existing
   * fire-and-forget `tasks.trigger(...)` call sites do today.
   */
  dispatch(run: AgentRun): Promise<void>;

  /**
   * Stop work in flight.
   *
   * For a queue-based backend the runner finds out at its next heartbeat, so
   * there is nothing to do here. For a hosted sandbox this must actually kill
   * the machine — a cancel that only marks the row leaves the model spending
   * money on work nobody wants.
   */
  cancel(run: AgentRun): Promise<void>;
}
