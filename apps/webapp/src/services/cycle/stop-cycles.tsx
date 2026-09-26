import { stopCycles } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useStopCyclesMutation = mutationHook(stopCycles);
