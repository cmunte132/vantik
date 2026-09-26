import type { CompleteCycleDto, Cycle } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface CompleteCycleDtoWithCycleId extends CompleteCycleDto {
  cycleId: string;
}

export function completeCycle({
  cycleId,
  ...completeCycleDto
}: CompleteCycleDtoWithCycleId): Promise<Cycle> {
  return ajaxPost({
    url: `/api/v1/cycles/${cycleId}/complete`,
    data: completeCycleDto,
  });
}

export const useCompleteCycleMutation = mutationHook(completeCycle);
