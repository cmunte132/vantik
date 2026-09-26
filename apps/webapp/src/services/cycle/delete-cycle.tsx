import type { CycleType } from 'common/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteCycle({
  cycleId,
}: {
  cycleId: string;
}): Promise<CycleType> {
  return ajaxDelete({ url: `/api/v1/cycles/${cycleId}` });
}

export const useDeleteCycleMutation = mutationHook(deleteCycle);
