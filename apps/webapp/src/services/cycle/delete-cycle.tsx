import { deleteCycle } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useDeleteCycleMutation = mutationHook(deleteCycle);
