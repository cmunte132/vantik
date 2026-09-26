import { connectIntegration, updateTeamMappings } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useConnectIntegrationMutation = mutationHook(connectIntegration);

export const useUpdateTeamMappingsMutation = mutationHook(updateTeamMappings, {
  fallback: 'The server refused this change, and it gave no reason.',
});
