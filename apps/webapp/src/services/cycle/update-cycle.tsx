import type { Cycle, UpdateCycleDto } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateCycleDtoWithCycleId extends UpdateCycleDto {
  cycleId: string;
}

export function updateCycle({
  cycleId,
  ...updateCycleDto
}: UpdateCycleDtoWithCycleId): Promise<Cycle> {
  return ajaxPost({ url: `/api/v1/cycles/${cycleId}`, data: updateCycleDto });
}

export const useUpdateCycleMutation = mutationHook(updateCycle);
