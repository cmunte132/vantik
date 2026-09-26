import type { TeamMapping } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

/**
 * Turn on an integration that declares `no_auth`.
 *
 * The account arrives back over the socket as a sync action, like any other
 * write to an integration account, so the caller needs no refetch.
 */
export function connectIntegration(body: {
  integrationDefinitionId: string;
  workspaceId: string;
}) {
  return ajaxPost({ url: '/api/v1/integration_account', data: body });
}

/** Replace which teams a workspace account routes work to. */
export function updateTeamMappings({
  integrationAccountId,
  teamMappings,
}: {
  integrationAccountId: string;
  teamMappings: TeamMapping[];
}) {
  return ajaxPost({
    url: `/api/v1/integration_account/${integrationAccountId}/team_mappings`,
    data: { teamMappings },
  });
}

export const useConnectIntegrationMutation = mutationHook(connectIntegration);

export const useUpdateTeamMappingsMutation = mutationHook(updateTeamMappings, {
  fallback: 'The server refused this change, and it gave no reason.',
});
