import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { sort } from 'fast-sort';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { IssueComment } from 'modules/issues/single-issue/left-side/activity/comments-activity/issue-comment';

import { type NotificationType, type User } from 'common/types';

import { useIssueData } from 'hooks/issues';
import { useUsersData } from 'hooks/users';

import { useContextStore } from 'store/global-context-provider';

import { NotificationUpdate } from './notification-update';
import { UpdateHeader } from './update-header';

/**
 * What the inbox shows when a row is opened.
 *
 * One column at the full width of the panel, because there is no property
 * rail to make room for: the issue's properties belong to the issue page,
 * which the header links to.
 *
 * Every notification the row stands for is listed, oldest first. The inbox has
 * always drawn one row per issue, so a row can be thirteen comments; showing
 * only the newest of them was how the rest became unreachable.
 */
export const InboxUpdateView = observer(() => {
  const issue = useIssueData();
  const { notificationsStore } = useContextStore();
  const { users, isLoading } = useUsersData(true);

  const getUserData = React.useCallback(
    (userId: string) => users.find((user: User) => user.id === userId),
    [users],
  );

  const updates = React.useMemo(() => {
    const forIssue = notificationsStore.notificationsForIssue(
      issue.id,
    ) as NotificationType[];

    // Oldest first, so the newest update is nearest the reply box, the way a
    // conversation reads.
    return sort(forIssue).asc((notification: NotificationType) =>
      new Date(notification.createdAt).getTime(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationsStore.notifications.length, issue]);

  if (isLoading) {
    return null;
  }

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      <UpdateHeader issue={issue} />

      <ScrollArea className="grow h-full w-full min-w-0">
        <div className="flex h-full w-full min-w-0 pb-[100px]">
          <div className="grow min-w-0 mx-auto flex flex-col gap-4 max-w-[97ch] px-6 py-5">
            {updates.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing new on this issue.
              </p>
            ) : (
              updates.map((notification: NotificationType) => (
                <NotificationUpdate
                  key={notification.id}
                  notification={notification}
                  issue={issue}
                  getUserData={getUserData}
                />
              ))
            )}

            <IssueComment />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
});
