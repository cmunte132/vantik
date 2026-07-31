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
 * Ownership also decides whether the agent ever holds a human-visible
 * credential, which is the load-bearing half of this distinction:
 *
 * - `personal`: a user provisioned it for their own use — to drive their own
 *   Claude Code or whichever agent they run — and it belongs to that person,
 *   recorded as `ownerUserId`. Its token *is* the product: somebody has to
 *   paste it into `.mcp.json` or a runner daemon.
 * - `workspace`: an identity belonging to nobody in particular, so
 *   `ownerUserId` is null and an admin rather than an owner retires it. **It is
 *   never issued a token.** A standing credential owned by no individual has
 *   unbounded blast radius and nobody to rotate it; anything that genuinely
 *   needs a long-lived token uses a personal agent, which is what the BYO
 *   runner daemon already does.
 *
 * This is orthogonal to a BOT. A BOT is an internal automation (the actions
 * feature), a different kind of principal altogether — not an agent, and never
 * described as one.
 */
export type AgentOwnership = 'personal' | 'workspace';

/** Validation source for the ownership a caller may ask for. */
export const AGENT_OWNERSHIPS: AgentOwnership[] = ['personal', 'workspace'];

/**
 * An agent account as it reads in a listing. Retiring an agent always leaves
 * the identity behind, so its past edits stay attributed to it.
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
  /**
   * Whether this agent can still act — a different question per ownership.
   *
   * For a `personal` agent it is whether a usable token remains, because
   * presenting one is how it acts. For a `workspace` agent it is whether the
   * identity has been disabled: it never holds a token, so counting tokens
   * would report every one of them as retired from the moment it was made.
   */
  active: boolean;
  /**
   * When any of this agent's tokens last authenticated, or null for never.
   *
   * Null is the useful case: an account that has never made a request is a
   * leftover from a script or an experiment, and telling those apart from the
   * ones in daily use is what stops the list growing without bound.
   *
   * Always null for a `workspace` agent, which has no tokens to derive it
   * from. Read it as "not applicable" there rather than as "never used".
   */
  lastUsedAt: string | null;
}

/** The identity half of a freshly provisioned agent, which both kinds get. */
type ProvisionedAgent = Omit<
  AgentSummary,
  'createdAt' | 'active' | 'ownership'
>;

/**
 * A freshly provisioned personal agent: the account, plus the one thing that
 * exists only at creation. The token is not in `AgentSummary` because no
 * listing can ever carry it — it is shown once and is not retrievable again.
 */
export interface PersonalAgentAccount extends ProvisionedAgent {
  ownership: 'personal';
  token: string;
}

/**
 * A freshly provisioned workspace agent: the identity, and nothing else.
 *
 * `token` is declared as `never` rather than left out, so that reading
 * `account.token` on this branch is a compile error naming the rule instead of
 * a silent `undefined` that reaches a config file as the string "undefined".
 */
export interface WorkspaceAgentAccount extends ProvisionedAgent {
  ownership: 'workspace';
  token?: never;
}

/**
 * What provisioning an agent returns.
 *
 * A union discriminated on ownership rather than one interface with an optional
 * token, because whether a credential exists at all is decided by ownership,
 * and the type is the cheapest place to enforce that. Returning a token on the
 * workspace branch is a compile error at the point somebody writes it. The
 * alternative — `token?: string` and every caller trusted to ignore it on the
 * workspace path — is a convention, and relying on conventions to keep
 * credentials from leaking is what this shape exists to stop.
 */
export type AgentAccount = PersonalAgentAccount | WorkspaceAgentAccount;
