import type { CompleteCycleDto } from '@vantikhq/types';

import type { CycleType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface CompleteCycleDtoWithCycleId extends CompleteCycleDto {
  cycleId: string;
}

export function completeCycle({
  cycleId,
  ...completeCycleDto
}: CompleteCycleDtoWithCycleId): Promise<CycleType> {
  return ajaxPost({
    url: `/api/v1/cycles/${cycleId}/complete`,
    data: completeCycleDto,
  });
}

export const useCompleteCycleMutation = mutationHook(completeCycle);
