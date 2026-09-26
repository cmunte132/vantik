import type { CreateCycleDto } from '@vantikhq/types';

import type { CycleType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createCycle(
  createCycleDto: CreateCycleDto,
): Promise<CycleType> {
  return ajaxPost({ url: '/api/v1/cycles/single', data: createCycleDto });
}

export const useCreateCycleMutation = mutationHook(createCycle);
