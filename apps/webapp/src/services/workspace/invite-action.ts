import type { Invite } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface InviteActionParams {
  inviteId: string;
  accept: boolean;
}

export function inviteAction({
  inviteId,
  accept,
}: InviteActionParams): Promise<Invite> {
  return ajaxPost({
    url: `/api/v1/workspaces/invite_action`,
    data: {
      inviteId,
      accept,
    },
  });
}

export const useInviteActionMutation = mutationHook(inviteAction);
