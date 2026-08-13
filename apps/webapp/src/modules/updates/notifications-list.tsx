import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { sort } from 'fast-sort';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';

import type { NotificationType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

import { NotificationItem } from './notification-item';
import { teamIdentifierOf } from './selected-issue';

export const NotificationsList = observer(() => {
  const { notificationsStore, issuesStore, teamsStore } = useContextStore();
  const {
    query: { issueId },
  } = useRouter();

  const notifications = sort(notificationsStore.getNotifications).desc(
    (notification: NotificationType) => new Date(notification.createdAt),
  ) as NotificationType[];

  /**
   * Which issue the route is showing, as an id.
   *
   * Resolved once, here, so that the rows compare issues by id. Each row used
   * to rebuild `ENG-89` from its own team to decide whether it was the open
   * one, which made two issues that share a number look like the same row.
   */
  const identifier = teamIdentifierOf(issueId);
  const selectedTeam = identifier
    ? teamsStore.getTeamWithIdentifier(identifier)
    : undefined;
  const selectedIssueId = selectedTeam
    ? issuesStore.getIssueByNumber(issueId as string, selectedTeam.id)?.id
    : undefined;

  return (
    <ScrollArea>
      <div className="flex flex-col pt-2">
        {notifications.map((notification: NotificationType, index: number) => (
          <NotificationItem
            notification={notification}
            key={notification.id}
            nextNotification={notifications[index + 1]}
            selectedIssueId={selectedIssueId}
          />
        ))}
      </div>
    </ScrollArea>
  );
});
