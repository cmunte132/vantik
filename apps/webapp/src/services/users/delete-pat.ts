import type { Pat, PatIdDto } from '@vantikhq/types';

import { ajaxDelete, mutationHook } from 'services/utils';

import { GetPats } from './get-pats';

export function deletePat(patIdDto: PatIdDto): Promise<Pat> {
  return ajaxDelete({ url: `/api/v1/users/pats/${patIdDto.patId}` });
}

export const useDeletePatMutation = mutationHook(deletePat, {
  invalidates: [GetPats],
});
