import type { CreateCycleDto, Cycle } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createCycle(createCycleDto: CreateCycleDto): Promise<Cycle> {
  return ajaxPost({ url: '/api/v1/cycles/single', data: createCycleDto });
}

export const useCreateCycleMutation = mutationHook(createCycle);
