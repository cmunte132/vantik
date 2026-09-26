import type { CreatePatDto } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createPat(createPatDto: CreatePatDto) {
  return ajaxPost({ url: `/api/v1/users/pat`, data: createPatDto });
}

export const useCreatePatMutation = mutationHook(createPat);
