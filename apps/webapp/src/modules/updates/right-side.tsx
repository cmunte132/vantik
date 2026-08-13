import { RiInboxLine } from '@remixicon/react';
import { observer } from 'mobx-react-lite';

import { useContextStore } from 'store/global-context-provider';

export const NotificationRightSide = observer(() => {
  const { notificationsStore } = useContextStore();

  // The store counts this, and it counts it over every notification rather
  // than over the one row each issue draws. Counting here from the rows told
  // the person there was nothing to read while the sidebar badge, which asks
  // the store, said otherwise.
  const unread = notificationsStore.unReadCount;

  return (
    <>
      <RiInboxLine className="text-muted-foreground" size={32} />
      <div className="text-muted-foreground">Inbox</div>
      <div className="text-muted-foreground text-sm">
        {unread === 1
          ? '1 unread notification'
          : `${unread} unread notifications`}
      </div>
    </>
  );
});
