import { describe, expect, it } from 'vitest';

import { agentRetirement } from './retirement';

/**
 * The wording is the only thing on this screen that tells an admin whether a
 * secret is loose, so the two ownerships are pinned rather than left to read
 * correctly by inspection.
 */
describe('agentRetirement', () => {
  it('calls it revoking for a personal agent, which really does hold a token', () => {
    expect(agentRetirement({ ownership: 'personal' })).toEqual({
      verb: 'revoke',
      retiredBadge: 'revoked',
      usageDetail: null,
    });
  });

  it('calls it disabling for a workspace agent, which holds none', () => {
    // Naming a credential here would send the reader looking for one that the
    // server refuses to mint.
    expect(agentRetirement({ ownership: 'workspace' })).toEqual({
      verb: 'disable',
      retiredBadge: 'disabled',
      usageDetail: 'holds no token',
    });
  });

  it('never offers a workspace agent a last-used time to misread', () => {
    // Last use comes from an agent's tokens. A workspace agent has none, so
    // the honest answer is what it holds, not "never used" for ever.
    expect(agentRetirement({ ownership: 'workspace' }).usageDetail).toBe(
      'holds no token',
    );
    expect(agentRetirement({ ownership: 'personal' }).usageDetail).toBeNull();
  });
});
