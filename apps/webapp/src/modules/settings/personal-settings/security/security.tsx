import { SettingSection } from 'modules/settings/setting-section';

import { Passkeys } from './passkeys';
import { SecurityForm } from './security-form';

export function Security() {
  return (
    <div className="flex flex-col gap-8">
      <SettingSection
        title="Passkeys"
        description="Sign in with your device instead of waiting for a login code"
      >
        <Passkeys />
      </SettingSection>

      <SettingSection title="Security" description="Change your password">
        <SecurityForm />
      </SettingSection>
    </div>
  );
}
