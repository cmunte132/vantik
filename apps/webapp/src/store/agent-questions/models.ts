import { types } from 'mobx-state-tree';

/**
 * One question that an agent asks a person, as the client holds it.
 *
 * `source`, `status` and the JSON columns stay loose: a newer server can add
 * a source or a status, and a strict model would reject the row.
 */
export const AgentQuestion = types.model({
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,

  workspaceId: types.string,
  issueId: types.string,
  agentRunId: types.union(types.string, types.null, types.undefined),
  agentSessionId: types.union(types.string, types.null, types.undefined),

  externalId: types.string,
  source: types.string,
  questions: types.frozen<unknown>(),

  status: types.string,
  answers: types.frozen<unknown>(),
  answeredById: types.union(types.string, types.null, types.undefined),
  answeredAt: types.union(types.string, types.null, types.undefined),

  assigneeId: types.string,
  expiresAt: types.string,
  deliveredAt: types.union(types.string, types.null, types.undefined),
});

export const AgentQuestionArray = types.array(AgentQuestion);
