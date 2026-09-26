import { revokeAgent } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

import { GetAgents } from './get-agents';

export const useRevokeAgentMutation = mutationHook(revokeAgent, {
  invalidates: [GetAgents],
});
