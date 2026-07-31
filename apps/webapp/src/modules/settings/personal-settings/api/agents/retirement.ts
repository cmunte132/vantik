import { type AgentSummary } from '@vantikhq/types';

/**
 * How a row talks about stopping an agent, which is not the same sentence for
 * the two ownerships.
 *
 * A personal agent holds a token somebody pasted into a client, so the thing
 * that gets destroyed is a credential and "revoke" names it. A workspace agent
 * never holds one — the server refuses to mint it — so there is nothing to
 * revoke, and what the control does is switch the identity off. Saying
 * "revoke" there would name a credential the reader would then go looking for
 * and never find.
 *
 * Pure, and separate from the component, so the distinction can be tested. It
 * is the kind of wording that reads as cosmetic and is not: it is the only
 * thing on the screen that tells an admin whether a secret is loose.
 */
export interface AgentRetirement {
  /** The destructive button's label. */
  verb: string;
  /** The badge shown once the agent can no longer act. */
  retiredBadge: string;
  /**
   * What to say instead of a last-used time.
   *
   * Last use is derived from an agent's tokens, so a workspace agent has none
   * to derive it from and would read "never used" for ever — which sounds like
   * a leftover to clear up rather than the normal, permanent state of an
   * identity that was never given a credential.
   */
  usageDetail: string | null;
}

export function agentRetirement(
  agent: Pick<AgentSummary, 'ownership'>,
): AgentRetirement {
  return agent.ownership === 'workspace'
    ? { verb: 'disable', retiredBadge: 'disabled', usageDetail: 'holds no token' }
    : { verb: 'revoke', retiredBadge: 'revoked', usageDetail: null };
}
