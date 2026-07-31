import { Loader } from '@vantikhq/ui/components/loader';
import { useRouter } from 'next/router';
import * as React from 'react';

import { ContentBox } from 'common/layouts/content-box';
import { SCROLLABLE_BOX, SCROLLABLE_CONTENT } from 'common/layouts/main-layout';
import { SettingsLayout } from 'common/layouts/settings-layout';

import { UserContext } from 'store/user-context';

import {
  SECTION_COMPONENTS,
  SECTION_TITLES,
  type SECTION_COMPONENTS_KEYS,
} from './personal-settings-constants';
import { Header } from '../header';

export function PersonalSettings() {
  const router = useRouter();
  const userData = React.useContext(UserContext);

  const settingsSection = router.query
    .settingsSection as SECTION_COMPONENTS_KEYS;
  const SectionComponent = settingsSection
    ? SECTION_COMPONENTS[settingsSection]
    : SECTION_COMPONENTS.profile;

  return (
    <div className="h-[100vh] flex flex-col w-full">
      <ContentBox innerClassName={SCROLLABLE_BOX}>
        <Header title={SECTION_TITLES[settingsSection]} />
        <div className={SCROLLABLE_CONTENT}>
          <div className="w-full p-4">
            {userData ? <SectionComponent /> : <Loader />}
          </div>
        </div>
      </ContentBox>
    </div>
  );
}

PersonalSettings.getLayout = function getLayout(page: React.ReactElement) {
  return <SettingsLayout>{page}</SettingsLayout>;
};
