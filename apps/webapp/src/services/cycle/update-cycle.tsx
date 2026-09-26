import type { UpdateCycleDto } from '@vantikhq/types';

import type { CycleType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateCycleDtoWithCycleId extends UpdateCycleDto {
  cycleId: string;
}

export function updateCycle({
  cycleId,
  ...updateCycleDto
}: UpdateCycleDtoWithCycleId): Promise<CycleType> {
  return ajaxPost({ url: `/api/v1/cycles/${cycleId}`, data: updateCycleDto });
}

export const useUpdateCycleMutation = mutationHook(updateCycle);
