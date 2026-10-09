import { types } from 'mobx-state-tree';

/**
 * One agent session on one issue, as the client holds it.
 *
 * `harness`, `location`, `channel` and `driver` stay plain strings rather than
 * unions: a newer server can add a harness or a channel, and a strict model
 * would reject the row instead of showing it.
 */
export const AgentSession = types.model({
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,

  workspaceId: types.string,
  issueId: types.string,
  actorUserId: types.string,

  externalId: types.string,
  harness: types.union(types.string, types.null, types.undefined),
  location: types.string,
  channel: types.string,

  driver: types.union(types.string, types.null, types.undefined),
  driverLeaseExpiresAt: types.union(types.string, types.null, types.undefined),

  parentSessionId: types.union(types.string, types.null, types.undefined),
  agentRunId: types.union(types.string, types.null, types.undefined),

  startedAt: types.string,
  lastActiveAt: types.string,
  endedAt: types.union(types.string, types.null, types.undefined),

  /** What a person did in their own terminal, from the omp session file. */
  terminalTurns: types.optional(types.number, 0),
  terminalCostUsd: types.optional(types.number, 0),
  /** When the newest of those turns happened. */
  terminalSeenAt: types.union(types.string, types.null, types.undefined),
});

export const AgentSessionArray = types.array(AgentSession);
