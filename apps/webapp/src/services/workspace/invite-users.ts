import type { RoleEnum } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export type InviteResponse = Record<string, string>;

export interface InviteUsersParams {
  emailIds: string;
  teamIds: string[];
  role: RoleEnum;
}

export function inviteUsers({
  emailIds,
  teamIds,
  role,
}: InviteUsersParams): Promise<InviteResponse> {
  return ajaxPost({
    url: `/api/v1/workspaces/invite_users`,
    data: {
      emailIds,
      teamIds,
      role,
    },
  });
}

export const useInviteUsersMutation = mutationHook(inviteUsers);
