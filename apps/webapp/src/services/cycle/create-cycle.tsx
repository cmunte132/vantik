import { createCycle } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useCreateCycleMutation = mutationHook(createCycle);
