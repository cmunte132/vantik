import { sort } from 'fast-sort';
import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import type { NotificationType } from 'common/types';

import { vantikDatabase } from 'store/database';

import { Notifications } from './models';

export const NotificationsStore: IAnyStateTreeNode = types
  .model({
    notifications: Notifications,
  })
  .actions((self) => {
    const update = (notification: NotificationType, id: string) => {
      const indexToUpdate = self.notifications.findIndex(
        (obj) => obj.id === id,
      );

      if (indexToUpdate !== -1) {
        // Update the object at the found index with the new data
        self.notifications[indexToUpdate] = {
          ...self.notifications[indexToUpdate],
          ...notification,
          // TODO fix the any and have a type with Issuetype
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      } else {
        self.notifications.push(notification);
      }
    };
    const deleteById = (id: string) => {
      const indexToDelete = self.notifications.findIndex(
        (obj) => obj.id === id,
      );

      if (indexToDelete !== -1) {
        self.notifications.splice(indexToDelete, 1);
      }
    };

    const load = flow(function* () {
      const notifications = yield vantikDatabase.notifications.toArray();

      self.notifications = Notifications.create(
        sort(notifications).desc(
          (notification: NotificationType) => new Date(notification.updatedAt),
        ),
      );
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    /**
     * This view gives the inbox one row for each issue.
     *
     * The row stands for the newest thing that happened on that issue, so the
     * representative is chosen by `createdAt`. It used to be chosen by
     * `updatedAt`, and marking a notification read is a write that moves
     * `updatedAt` to now: the one the person had just read then beat every
     * unread notification on the same issue and became the only one the list
     * could see. Reading one update hid all the others.
     */
    get getNotifications() {
      const newestCreatedAt: Record<string, string> = {};
      const newestObjects: Record<string, NotificationType> = {};

      self.notifications.forEach((obj) => {
        const { issueId, createdAt } = obj;

        if (!newestCreatedAt[issueId] || createdAt > newestCreatedAt[issueId]) {
          newestCreatedAt[issueId] = createdAt;
          newestObjects[issueId] = obj as NotificationType;
        }
      });

      return Object.values(newestObjects);
    },

    /** Every notification on one issue, newest first. */
    notificationsForIssue(issueId: string) {
      const forIssue = self.notifications.filter(
        (obj) => obj.issueId === issueId,
      ) as unknown as NotificationType[];

      return sort(forIssue).desc(
        (obj: NotificationType) => new Date(obj.createdAt),
      );
    },

    /** A row is unread while any notification behind it is unread. */
    hasUnreadForIssue(issueId: string) {
      return self.notifications.some(
        (obj) => obj.issueId === issueId && !obj.readAt,
      );
    },

    /**
     * The count is over rows, not over notifications: the list draws one row
     * for each issue, and a badge that counts the notifications hidden behind
     * those rows would never agree with what is on the screen.
     */
    get unReadCount() {
      const issuesWithUnread = new Set(
        self.notifications
          .filter((obj) => !obj.readAt)
          .map((obj) => obj.issueId),
      );

      return issuesWithUnread.size;
    },
  }));

export type NotificationsStoreType = Instance<typeof NotificationsStore>;
