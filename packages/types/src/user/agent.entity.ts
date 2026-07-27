/**
 * What an agent is allowed to do.
 *
 * Deliberately coarse. The point is least privilege for a principal that acts
 * on its own, not a permission matrix: an agent should be able to read the
 * board and file and update work without also being able to delete things.
 */
export type AgentScope = 'read' | 'write' | 'delete';

export const AGENT_SCOPES: AgentScope[] = ['read', 'write', 'delete'];

/**
 * What a new agent gets unless someone asks for more. Reading and writing cover
 * everything the MCP tools do — file, update, comment, close — while deletion,
 * the one irreversible verb, has to be granted deliberately.
 */
export const DEFAULT_AGENT_SCOPES: AgentScope[] = ['read', 'write'];

/**
 * Who an agent account belongs to.
 *
 * - `personal`: a user provisioned it for their own use — to drive their own
 *   Claude Code or whichever agent they run — and it belongs to that person,
 *   recorded as `ownerUserId`.
 * - `workspace`: a shared credential — held by CI, a scheduled job or a shared
 *   runner — belonging to nobody in particular, so `ownerUserId` is null and
 *   an admin rather than an owner retires it.
 *
 * This is orthogonal to a BOT. A BOT is an internal automation (the actions
 * feature), a different kind of principal altogether — not an agent, and never
 * described as one.
 */
export type AgentOwnership = 'personal' | 'workspace';

/** Validation source for the ownership a caller may ask for. */
export const AGENT_OWNERSHIPS: AgentOwnership[] = ['personal', 'workspace'];

/**
 * An agent account as it reads in a listing. `active` is whether the agent
 * still has a usable token; revoking deletes the token but leaves the identity
 * for attribution.
 */
export interface AgentSummary {
  id: string;
  name: string;
  email: string;
  ownership: AgentOwnership;
  /** The owning user for a `personal` agent; null when the app owns it. */
  ownerUserId: string | null;
  /** What this agent may do; enforced by AgentScopeGuard on every request. */
  scopes: AgentScope[];
  createdAt: string;
  active: boolean;
  /**
   * When any of this agent's tokens last authenticated, or null for never.
   *
   * Null is the useful case: an account that has never made a request is a
   * leftover from a script or an experiment, and telling those apart from the
   * ones in daily use is what stops the list growing without bound.
   */
  lastUsedAt: string | null;
}

/**
 * A freshly provisioned agent: the same account, plus the one thing that exists
 * only at creation. It is not in `AgentSummary` because no listing can ever
 * carry it — the token is shown once and is not retrievable again.
 */
export interface AgentAccount
  extends Omit<AgentSummary, 'createdAt' | 'active'> {
  token: string;
}
