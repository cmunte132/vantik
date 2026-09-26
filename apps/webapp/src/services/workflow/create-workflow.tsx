import { createWorkflow } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useCreateWorkflowMutation = mutationHook(createWorkflow);
