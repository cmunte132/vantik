import { NotificationTypeEnum, type NotificationType } from 'common/types';

/**
 * What a notification carries besides the issue it points at.
 *
 * The server writes one of these keys per notification type, in
 * `notifications/delivery/utils.ts`. Nothing carries more than one, and the
 * key that is present follows from `type`, so the reader picks the field it
 * knows its own type uses rather than testing each one.
 */
export interface NotificationActionData {
  /** IssueNewComment: the comment that arrived. */
  issueCommentId?: string;
  /** IssueStatusChanged: the workflow the issue moved to. */
  stateId?: string;
  /** IssuePriorityChanged: the new priority, written as a string. */
  priorityId?: string;
  /** IssueAssigned and IssueUnAssigned: the person handed the issue, or taken off it. */
  userId?: string;
  /** IssueBlocks: the relation that says what blocks this issue. */
  issueRelationId?: string;
}

/**
 * This function reads the payload the sync engine stored as a string.
 *
 * A notification whose payload cannot be read is still a notification: the
 * type and the issue are enough to say that something happened. So a bad or
 * missing payload gives an empty object and the view falls back to its plain
 * wording, rather than taking the inbox down with it.
 */
export function getActionData(
  notification: NotificationType,
): NotificationActionData {
  if (!notification.actionData) {
    return {};
  }

  try {
    const parsed = JSON.parse(notification.actionData);

    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The sentence a notification makes on its own, with no payload resolved.
 *
 * This is what the list rows show, and what an update falls back to when the
 * record it points at has not reached this client yet.
 */
export function getNotificationText(
  userName: string,
  notificationType: NotificationTypeEnum,
): string {
  switch (notificationType) {
    case NotificationTypeEnum.IssueAssigned: {
      return `Assigned by ${userName}`;
    }

    case NotificationTypeEnum.IssueUnAssigned: {
      return `Unassigned by ${userName}`;
    }

    case NotificationTypeEnum.IssueStatusChanged: {
      return `Status changed by ${userName}`;
    }

    case NotificationTypeEnum.IssuePriorityChanged: {
      return `Priority changed by ${userName}`;
    }

    case NotificationTypeEnum.IssueNewComment: {
      return `New comment from ${userName}`;
    }

    case NotificationTypeEnum.IssueBlocks: {
      return `Marked as blocked by ${userName}`;
    }
  }

  return 'New notification';
}
