import { deletePat } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

import { GetPats } from './get-pats';

export const useDeletePatMutation = mutationHook(deletePat, {
  invalidates: [GetPats],
});
