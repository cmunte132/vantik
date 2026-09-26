import { authorizeCode } from '@vantikhq/services';

import { mutationHook } from 'services/utils';

export const useAuthorizeMutation = mutationHook(authorizeCode);
