import { ajaxPost, mutationHook } from 'services/utils';

import { GetAgents } from './get-agents';

/**
 * Clears revoked agents out of the listing.
 *
 * Hides rather than deletes, and that distinction is the whole reason this is
 * safe to offer: these accounts authored issues and comments, so removing the
 * user would break attribution on records that still name them. A revoked agent
 * cannot authenticate, so the row is all there is left to remove.
 */
function clearRevokedAgents({
  workspaceId,
}: {
  workspaceId: string;
}): Promise<{ hidden: number }> {
  return ajaxPost({
    url: `/api/v1/users/agents/clear_revoked?workspaceId=${workspaceId}`,
    data: {},
  });
}

export const useClearRevokedAgentsMutation = mutationHook(clearRevokedAgents, {
  invalidates: [GetAgents],
  fallback: 'Could not clear the revoked agents.',
});
