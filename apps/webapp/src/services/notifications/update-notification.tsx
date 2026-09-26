import type { NotificationType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface UpdateNotificationParams {
  notificationId: string;
  readAt: string;
}

export function updateNotification({
  notificationId,
  readAt,
}: UpdateNotificationParams): Promise<NotificationType> {
  return ajaxPost({
    url: `/api/v1/notifications/${notificationId}`,
    data: { readAt },
  });
}

export const useUpdateNotificationMutation = mutationHook(updateNotification);
