import { createPat } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useCreatePatMutation = mutationHook(createPat);
