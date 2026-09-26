import type { Cycle } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function startCycle({ cycleId }: { cycleId: string }): Promise<Cycle> {
  return ajaxPost({ url: `/api/v1/cycles/${cycleId}/start` });
}

export const useStartCycleMutation = mutationHook(startCycle);
