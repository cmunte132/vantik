import { Button } from '@vantikhq/ui/components/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { useTheme } from 'next-themes';
import React from 'react';

import { SettingSection } from 'modules/settings/setting-section';

import { resync } from 'store/resync';

export function Preferences() {
  const { theme, setTheme } = useTheme();
  const [rebuilding, setRebuilding] = React.useState(false);

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-xl"> Preferences </h2>
      <SettingSection
        title="Theme"
        description="Choose a preferred theme for the app."
      >
        <Select
          value={theme}
          onValueChange={(value: string) => {
            setTheme(value);
          }}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Select your theme" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </SettingSection>

      {/* The server repairs the sync log after downtime and asks clients to
          rebuild when their history cannot be served, so this should almost
          never be needed. It exists because "almost never" is not never, and
          the alternative anyone reaches for otherwise is clearing site data,
          which signs them out too. */}
      <SettingSection
        title="Local data"
        description="Vantik keeps a copy of this workspace in your browser and updates it as things change. If something looks out of date or shows up that should not exist, rebuild it from the server."
      >
        <Button
          variant="secondary"
          isLoading={rebuilding}
          onClick={() => {
            setRebuilding(true);
            resync();
          }}
        >
          Rebuild local data
        </Button>
      </SettingSection>
    </div>
  );
}
