import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import React from 'react';
import ReactTimeAgo from 'react-time-ago';

import { type NotificationType } from 'common/types';
import { workspaceHref } from 'common/workspace-href';

import { useTeamWithId } from 'hooks/teams';
import { useUserData } from 'hooks/users';

import { useUpdateNotificationMutation } from 'services/notifications';

import { useContextStore } from 'store/global-context-provider';

import { getNotificationText } from './action-data';
import { dividerHidden } from './selected-issue';

interface NotificationItemProps {
  notification: NotificationType;
  nextNotification: NotificationType | undefined;
  /** The issue the route is showing, resolved once by the list. */
  selectedIssueId: string | undefined;
}

export const NotificationItem = observer(
  ({
    notification,
    nextNotification,
    selectedIssueId,
  }: NotificationItemProps) => {
    const { issuesStore, notificationsStore } = useContextStore();

    const issue = issuesStore.getIssueById(notification.issueId);
    const hasUnread = notificationsStore.hasUnreadForIssue(
      notification.issueId,
    );
    const updateCount = notificationsStore.notificationsForIssue(
      notification.issueId,
    ).length;

    const { user, isLoading } = useUserData(notification.createdById);
    const {
      query: { workspaceSlug },
      push,
    } = useRouter();
    const { mutate: updateNotification } = useUpdateNotificationMutation({});
    const team = useTeamWithId(issue?.teamId);

    const isSelected = notification.issueId === selectedIssueId;
    const noBorder = dividerHidden(
      notification.issueId,
      nextNotification?.issueId,
      selectedIssueId,
    );

    // A notification can outlive this client's sight of its issue: the sync
    // engine sends notifications for every team and issues only for the teams
    // this person can see, so leaving a team leaves the notifications behind.
    // There is nothing truthful to draw, and reading through the missing issue
    // would throw and take the whole inbox down with it.
    if (isLoading || !issue || !team) {
      return null;
    }

    return (
      <div
        className={cn(
          'ml-4 p-3 py-0 mr-4 flex gap-1 items-center hover:bg-grayAlpha-200 rounded',
          isSelected && 'bg-grayAlpha-100',
        )}
        onClick={() => {
          push(
            workspaceHref(
              workspaceSlug,
              'inbox',
              `${team.identifier}-${issue.number}`,
            ),
          );
          // The row stands for the issue, so opening it clears every
          // notification behind the row. Marking only the representative left
          // the rest unread forever: nothing else in the inbox can reach them.
          const readAt = new Date().toISOString();

          notificationsStore
            .notificationsForIssue(notification.issueId)
            .filter((item: NotificationType) => !item.readAt)
            .forEach((item: NotificationType) => {
              updateNotification({ notificationId: item.id, readAt });
            });
        }}
      >
        <div
          className={cn(
            'flex flex-col gap-1 py-2 w-full',
            !noBorder && 'border-b',
          )}
        >
          <div className="flex justify-between text-sm">
            <div
              className={cn(
                'w-[calc(100%_-_110px)]',
                hasUnread ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <div className="truncate">{issue.title}</div>
            </div>
            <div className="text-muted-foreground w-[70px] text-right">{`${team.identifier}-${issue.number}`}</div>
          </div>

          <div className="flex justify-between text-xs">
            {/*
              The row stands for every update on the issue, so it says how many
              there are. Naming only the newest was what made a row of thirteen
              comments look like one.
            */}
            <div className="flex gap-2 text-muted-foreground">
              {getNotificationText(user?.username, notification.type)}
              {updateCount > 1 && <span>{`+${updateCount - 1} more`}</span>}
            </div>

            <div className="text-muted-foreground">
              <ReactTimeAgo
                date={new Date(issue.updatedAt)}
                timeStyle="twitter"
              />
            </div>
          </div>
        </div>
      </div>
    );
  },
);
