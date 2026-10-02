import type { NotificationPreferences } from '@vantikhq/types';

import { ajaxPut, mutationHook } from 'services/utils';

import { GetUserQuery } from './get-user';

export interface UpdateUserParams {
  fullname?: string;
  username?: string;
  hideEmail?: boolean;
  /** Partial: the server merges what is sent over what it has. */
  notificationPreferences?: NotificationPreferences;
}

function updateUser(data: UpdateUserParams) {
  return ajaxPut({
    url: `/api/v1/users`,
    data,
  });
}

export const useUpdateUserMutation = mutationHook(updateUser, {
  invalidates: [GetUserQuery],
});
