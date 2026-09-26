import { createAgent } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

import { GetAgents } from './get-agents';

export const useCreateAgentMutation = mutationHook(createAgent, {
  invalidates: [GetAgents],
});
