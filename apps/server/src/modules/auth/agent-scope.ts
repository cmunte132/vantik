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
 * Falls back to the default rather than to nothing, which covers both an
 * unusable request and an agent provisioned before scopes existed: one that was
 * never granted deletion should not hold it by accident of having been created
 * early, and one whose grant is empty should still be able to work.
 */
export function sanitizeScopes(requested?: unknown): AgentScope[] {
  if (!Array.isArray(requested)) {
    return DEFAULT_AGENT_SCOPES;
  }

  const valid = [
    ...new Set(
      requested.filter((scope): scope is AgentScope =>
        AGENT_SCOPES.includes(scope as AgentScope),
      ),
    ),
  ];

  return valid.length > 0 ? valid : DEFAULT_AGENT_SCOPES;
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
} {
  const agent = (
    settings as {
      agent?: {
        ownership?: AgentOwnership;
        ownerUserId?: string | null;
        scopes?: unknown;
      };
    } | null
  )?.agent;

  return {
    ownership: agent?.ownership ?? 'personal',
    ownerUserId: agent?.ownerUserId ?? null,
    scopes: sanitizeScopes(agent?.scopes),
  };
}
