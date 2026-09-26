import { SettingSection } from 'modules/settings/setting-section';

import { Passkeys } from './passkeys';

export function Security() {
  return (
    <div className="flex flex-col gap-8">
      <SettingSection
        title="Passkeys"
        description="Sign in with your device instead of waiting for a login code"
      >
        <Passkeys />
      </SettingSection>
    </div>
  );
}
