import { SetMetadata } from '@nestjs/common';
import {
  AGENT_SCOPES,
  AgentOwnership,
  AgentScope,
  DEFAULT_AGENT_SCOPES,
} from '@vantikhq/types';

export const SKIP_AGENT_SCOPE = 'skipAgentScope';

export const REQUIRED_AGENT_SCOPE = 'requiredAgentScope';

/**
 * Declares the scope a route needs, overriding what its method implies.
 *
 * For reads that arrive as a POST because they carry a body — `POST
 * /v1/issues/filter` is the board itself — where the method would otherwise
 * read as a write and lock a read-only agent out of the thing it exists to do.
 */
export const RequiresScope = (scope: AgentScope) =>
  SetMetadata(REQUIRED_AGENT_SCOPE, scope);

/**
 * Exempts a route from the scope check.
 *
 * For endpoints whose HTTP method says nothing about what the request will do
 * — the MCP endpoint is one POST covering every tool, read-only ones included.
 * Exempting it is safe because its tools reach the API over loopback, so the
 * work they actually do is scope-checked on the way through.
 */
export const SkipAgentScope = () => SetMetadata(SKIP_AGENT_SCOPE, true);

/**
 * The scope a request needs, read off its method.
 *
 * Method is a coarse proxy for intent, but it is the honest default at the
 * guard: it is what the router dispatches on and it does not drift as handlers
 * change. Anything unsafe that is not a deletion counts as a write, and a route
 * that reads through a POST says so with `@RequiresScope('read')`.
 */
export function requiredScopeFor(method: string): AgentScope {
  const verb = method.toUpperCase();

  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') {
    return 'read';
  }

  if (verb === 'DELETE') {
    return 'delete';
  }

  return 'write';
}

/**
 * Normalises a scope list, dropping duplicates and anything this server does
 * not recognise.
 *
 * The absence of a list and an empty list mean different things. Nothing at all
 * — an agent provisioned before scopes existed, or a request that omits them —
 * gets the default, so such an agent still works without silently holding
 * deletion it was never granted. A list that *is* present is taken at its word
 * and narrowed to what this server knows, down to nothing if that is what
 * survives: an explicit empty grant, or names this server no longer recognises
 * after a rename, must not widen into read and write. A copy is returned so no
 * caller can mutate the shared default.
 */
export function sanitizeScopes(requested?: unknown): AgentScope[] {
  if (!Array.isArray(requested)) {
    return [...DEFAULT_AGENT_SCOPES];
  }

  return [
    ...new Set(
      requested.filter((scope): scope is AgentScope =>
        AGENT_SCOPES.includes(scope as AgentScope),
      ),
    ),
  ];
}

/**
 * What an agent membership's `settings` blob records about the agent: who owns
 * it and what it may do. Read through here rather than off the JSON directly,
 * so the provisioning screen shows what the guard actually enforces.
 */
export function agentSettings(settings: unknown): {
  ownership: AgentOwnership;
  ownerUserId: string | null;
  scopes: AgentScope[];
  /**
   * When a revoked agent was cleared from the listing, or null.
   *
   * Presentation rather than permission — a hidden agent is hidden because it
   * can no longer do anything, never as a way of restricting one that can.
   */
  hiddenAt: string | null;
} {
  const agent = (
    settings as {
      agent?: {
        ownership?: AgentOwnership;
        ownerUserId?: string | null;
        scopes?: unknown;
        hiddenAt?: string | null;
      };
    } | null
  )?.agent;

  return {
    ownership: agent?.ownership ?? 'personal',
    ownerUserId: agent?.ownerUserId ?? null,
    scopes: sanitizeScopes(agent?.scopes),
    hiddenAt: agent?.hiddenAt ?? null,
  };
}
