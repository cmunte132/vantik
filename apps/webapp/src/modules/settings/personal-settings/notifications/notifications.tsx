import {
  RiInboxLine,
  RiMailLine,
  type RemixiconComponentType,
} from '@remixicon/react';
import {
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences,
} from '@vantikhq/types';
import { Switch } from '@vantikhq/ui/components/switch';
import { useToast } from '@vantikhq/ui/components/use-toast';
import React from 'react';

import { SettingSection } from 'modules/settings/setting-section';

import { useUpdateUserMutation } from 'services/users';

import { UserContext } from 'store/user-context';

const CATEGORIES: Array<{
  category: NotificationCategory;
  title: string;
  description: string;
}> = [
  {
    category: 'assignments',
    title: 'Assignments',
    description: 'An issue is assigned to you, or taken off you.',
  },
  {
    category: 'comments',
    title: 'Comments',
    description: 'Someone comments on an issue you follow.',
  },
  {
    category: 'statusChanges',
    title: 'Completed',
    description: 'An issue you follow is marked done.',
  },
  {
    category: 'priorityChanges',
    title: 'Marked urgent',
    description: 'An issue you follow becomes urgent.',
  },
  {
    category: 'blocking',
    title: 'Blocked',
    description: 'An issue you follow is blocked by another.',
  },
];

const CHANNELS: Array<{
  channel: NotificationChannel;
  label: string;
  Icon: RemixiconComponentType;
}> = [
  { channel: 'inApp', label: 'Inbox', Icon: RiInboxLine },
  { channel: 'email', label: 'Email', Icon: RiMailLine },
];

// One description column, then a fixed column per channel so the switches
// line up down the page whatever the description wraps to.
const ROW = 'grid grid-cols-[minmax(0,1fr)_4rem_4rem] items-center gap-x-2';

const isOn = (
  preferences: NotificationPreferences,
  category: NotificationCategory,
  channel: NotificationChannel,
) => preferences[category]?.[channel] !== false;

export function Notifications() {
  const currentUser = React.useContext(UserContext);
  const { toast } = useToast();
  // The switches move at once; the user query refetches behind them.
  const [preferences, setPreferences] = React.useState<NotificationPreferences>(
    currentUser.notificationPreferences ?? {},
  );
  const { mutate: updateUser } = useUpdateUserMutation({
    onError: (message) => {
      setPreferences(currentUser.notificationPreferences ?? {});
      toast({ variant: 'destructive', title: 'Error!', description: message });
    },
  });

  /** Sends only what moved; the server merges it over the rest. */
  const save = (
    categories: NotificationCategory[],
    channel: NotificationChannel,
    checked: boolean,
  ) => {
    const update: NotificationPreferences = {};
    for (const category of categories) {
      update[category] = { [channel]: checked };
    }
    setPreferences((current) => {
      const next = { ...current };
      for (const category of categories) {
        next[category] = { ...current[category], [channel]: checked };
      }
      return next;
    });
    updateUser({ notificationPreferences: update });
  };

  return (
    <SettingSection
      title="Notifications"
      description="Choose what reaches you, and where. Nothing you do yourself ever notifies you."
      metadata={
        <p className="text-muted-foreground mt-3">
          Email goes to {currentUser.email}.
        </p>
      }
    >
      <div className="flex flex-col">
        <div className={`${ROW} pb-3 border-b border-border`}>
          <span className="text-muted-foreground">Everything</span>
          {CHANNELS.map(({ channel, label, Icon }) => {
            const allOn = CATEGORIES.every(({ category }) =>
              isOn(preferences, category, channel),
            );
            return (
              <div key={channel} className="flex flex-col items-center gap-1.5">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Icon size={14} />
                  {label}
                </span>
                <Switch
                  aria-label={`All ${label.toLowerCase()} notifications`}
                  checked={allOn}
                  onCheckedChange={(checked: boolean) =>
                    save(
                      CATEGORIES.map(({ category }) => category),
                      channel,
                      checked,
                    )
                  }
                />
              </div>
            );
          })}
        </div>

        {CATEGORIES.map(({ category, title, description }) => (
          <div
            key={category}
            className={`${ROW} py-3 border-b border-border last:border-b-0`}
          >
            <div className="flex flex-col min-w-0">
              <span>{title}</span>
              <span className="text-muted-foreground">{description}</span>
            </div>
            {CHANNELS.map(({ channel, label }) => (
              <div key={channel} className="flex justify-center">
                <Switch
                  aria-label={`${title} by ${label.toLowerCase()}`}
                  checked={isOn(preferences, category, channel)}
                  onCheckedChange={(checked: boolean) =>
                    save([category], channel, checked)
                  }
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </SettingSection>
  );
}
