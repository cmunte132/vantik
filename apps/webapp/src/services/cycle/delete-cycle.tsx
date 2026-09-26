import type { Cycle } from '@vantikhq/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteCycle({ cycleId }: { cycleId: string }): Promise<Cycle> {
  return ajaxDelete({ url: `/api/v1/cycles/${cycleId}` });
}

export const useDeleteCycleMutation = mutationHook(deleteCycle);
