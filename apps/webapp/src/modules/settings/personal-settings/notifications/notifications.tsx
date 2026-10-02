import {
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences,
} from '@vantikhq/types';
import { Label } from '@vantikhq/ui/components/label';
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
    description:
      'Someone assigns an issue to you, or takes one you were assigned off you.',
  },
  {
    category: 'comments',
    title: 'Comments',
    description: 'Someone comments on an issue you are subscribed to.',
  },
  {
    category: 'statusChanges',
    title: 'Status changes',
    description: 'An issue you are subscribed to is completed.',
  },
  {
    category: 'priorityChanges',
    title: 'Priority changes',
    description: 'An issue you are subscribed to is marked urgent.',
  },
  {
    category: 'blocking',
    title: 'Blocking',
    description: 'An issue you are subscribed to becomes blocked by another.',
  },
];

const CHANNELS: Array<{ channel: NotificationChannel; label: string }> = [
  { channel: 'inApp', label: 'Inbox' },
  { channel: 'email', label: 'Email' },
];

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

  const save = (
    category: NotificationCategory,
    channel: NotificationChannel,
    checked: boolean,
  ) => {
    setPreferences((current) => ({
      ...current,
      [category]: { ...current[category], [channel]: checked },
    }));
    // Only the switch that moved; the server merges it over the rest.
    updateUser({
      notificationPreferences: { [category]: { [channel]: checked } },
    });
  };

  return (
    <div className="flex flex-col gap-8">
      {CATEGORIES.map(({ category, title, description }) => (
        <SettingSection key={category} title={title} description={description}>
          <div className="flex flex-col gap-4">
            {CHANNELS.map(({ channel, label }) => {
              const id = `notify-${category}-${channel}`;
              return (
                <div key={channel} className="flex items-center gap-3">
                  <Switch
                    id={id}
                    checked={preferences[category]?.[channel] !== false}
                    onCheckedChange={(checked: boolean) =>
                      save(category, channel, checked)
                    }
                  />
                  <Label htmlFor={id}>{label}</Label>
                </div>
              );
            })}
          </div>
        </SettingSection>
      ))}
    </div>
  );
}
