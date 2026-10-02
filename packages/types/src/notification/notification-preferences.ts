import { NotificationActionType } from './notification.entity';

/**
 * The groups a person chooses delivery for. Fewer than the action types:
 * being assigned and being unassigned are one decision, not two.
 */
export const NOTIFICATION_CATEGORIES = [
  'assignments',
  'comments',
  'statusChanges',
  'priorityChanges',
  'blocking',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** The places a notification can reach a person. */
export const NOTIFICATION_CHANNELS = ['inApp', 'email'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type NotificationCategoryPreference = Partial<
  Record<NotificationChannel, boolean>
>;

/**
 * What `User.notificationPreferences` holds. Sparse on purpose: a category or
 * channel that is absent is on. Everybody who never opened the settings page
 * keeps the delivery they had before the page existed.
 */
export type NotificationPreferences = Partial<
  Record<NotificationCategory, NotificationCategoryPreference>
>;

const CATEGORY_BY_TYPE: Record<NotificationActionType, NotificationCategory> = {
  [NotificationActionType.IssueAssigned]: 'assignments',
  [NotificationActionType.IssueUnAssigned]: 'assignments',
  [NotificationActionType.IssueNewComment]: 'comments',
  [NotificationActionType.IssueStatusChanged]: 'statusChanges',
  [NotificationActionType.IssuePriorityChanged]: 'priorityChanges',
  [NotificationActionType.IssueBlocks]: 'blocking',
};

export function notificationCategoryOf(
  type: NotificationActionType,
): NotificationCategory | undefined {
  return CATEGORY_BY_TYPE[type];
}

/**
 * Whether a person wants this kind of notification on this channel.
 *
 * Takes the raw column value, because that is what Prisma hands back: a JSON
 * value of any shape. Anything that is not an explicit `false` is a yes, so a
 * malformed value fails open to today's behaviour rather than silencing
 * somebody without their asking.
 */
export function wantsNotification(
  preferences: unknown,
  type: NotificationActionType,
  channel: NotificationChannel,
): boolean {
  const category = notificationCategoryOf(type);
  if (!category || !preferences || typeof preferences !== 'object') {
    return true;
  }

  const forCategory = (preferences as NotificationPreferences)[category];
  if (!forCategory || typeof forCategory !== 'object') {
    return true;
  }

  return forCategory[channel] !== false;
}

/**
 * Keeps only known categories and channels with boolean values. The server
 * stores what this returns, so a client cannot grow the column with keys
 * nothing reads.
 */
export function sanitizeNotificationPreferences(
  value: unknown,
): NotificationPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const result: NotificationPreferences = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    const forCategory = (value as Record<string, unknown>)[category];
    if (!forCategory || typeof forCategory !== 'object') {
      continue;
    }

    const kept: NotificationCategoryPreference = {};
    for (const channel of NOTIFICATION_CHANNELS) {
      const setting = (forCategory as Record<string, unknown>)[channel];
      if (typeof setting === 'boolean') {
        kept[channel] = setting;
      }
    }
    if (Object.keys(kept).length > 0) {
      result[category] = kept;
    }
  }
  return result;
}
