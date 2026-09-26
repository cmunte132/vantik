import { suspendUser } from '@vantikhq/services';

import { GetUserQuery } from 'services/users';
import { mutationHook } from 'services/utils';

export const useSuspendUserMutation = mutationHook(suspendUser, {
  invalidates: [GetUserQuery],
});
