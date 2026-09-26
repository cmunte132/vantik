import type { TeamMapping } from '@vantikhq/types';

import axios from 'axios';

/**
 * Turn on an integration that declares `no_auth`.
 *
 * The account arrives back over the socket as a sync action, like any other
 * write to an integration account, so the caller needs no refetch.
 */
export async function connectIntegration(body: {
  integrationDefinitionId: string;
  workspaceId: string;
}) {
  const response = await axios.post('/api/v1/integration_account', body);

  return response.data;
}

/** Replace which teams a workspace account routes work to. */
export async function updateTeamMappings({
  integrationAccountId,
  teamMappings,
}: {
  integrationAccountId: string;
  teamMappings: TeamMapping[];
}) {
  const response = await axios.post(
    `/api/v1/integration_account/${integrationAccountId}/team_mappings`,
    { teamMappings },
  );

  return response.data;
}
