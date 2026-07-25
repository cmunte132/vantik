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
 * - `workspace`: created and owned within the app itself, not tied to any one
 *   person. Not provisionable yet; the value exists so the two kinds can be
 *   told apart from the first agent, ahead of the features that will own them.
 *
 * This is orthogonal to a BOT. A BOT is an internal automation (the actions
 * feature), a different kind of principal altogether — not an agent, and never
 * described as one.
 */
export type AgentOwnership = 'personal' | 'workspace';

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
