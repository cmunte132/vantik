import { types } from 'mobx-state-tree';

/**
 * One agent's attempt at one issue, as the client holds it.
 *
 * `result`, `config` and `phaseTimings` stay frozen blobs rather than typed
 * models: their shape varies by executor and by delivery, and a strict MST
 * model would reject a run produced by a newer server than this bundle.
 */
export const AgentRun = types.model({
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,

  workspaceId: types.string,
  issueId: types.string,
  agentUserId: types.string,
  createdById: types.union(types.string, types.null, types.undefined),

  executor: types.string,
  status: types.string,
  attempt: types.number,

  startedAt: types.union(types.string, types.null, types.undefined),
  finishedAt: types.union(types.string, types.null, types.undefined),

  summary: types.union(types.string, types.null, types.undefined),
  error: types.union(types.string, types.null, types.undefined),
  failure: types.union(types.string, types.null, types.undefined),

  result: types.frozen(),
  config: types.frozen(),
  harnessVersion: types.union(types.string, types.null, types.undefined),
  modelId: types.union(types.string, types.null, types.undefined),
  iterationCount: types.union(types.number, types.null, types.undefined),
  // How long each phase took. The timeline reads it to put a duration beside
  // a phase heading, which is the difference between "it ran" and "setup took
  // four of the five minutes".
  phaseTimings: types.frozen(),
});

export const AgentRunArray = types.array(AgentRun);

/** An append-only progress line. */
export const AgentRunEvent = types.model({
  id: types.string,
  createdAt: types.string,
  at: types.string,
  level: types.string,
  message: types.string,
  phase: types.union(types.string, types.null, types.undefined),
  runId: types.string,
});

export const AgentRunEventArray = types.array(AgentRunEvent);
