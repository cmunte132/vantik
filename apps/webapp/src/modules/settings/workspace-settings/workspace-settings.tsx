import { useRouter } from 'next/router';

import { ContentBox } from 'common/layouts/content-box';
import { SCROLLABLE_BOX, SCROLLABLE_CONTENT } from 'common/layouts/main-layout';
import { SettingsLayout } from 'common/layouts/settings-layout';

import {
  type SECTION_COMPONENTS_KEYS,
  SECTION_COMPONENTS,
  SECTION_TITLES,
} from './workspace-settings-constants';
import { Header } from '../header';

export function WorkspaceSettings() {
  const router = useRouter();
  const settingsSection = router.query
    .settingsSection as SECTION_COMPONENTS_KEYS;
  const SectionComponent = settingsSection
    ? SECTION_COMPONENTS[settingsSection]
    : SECTION_COMPONENTS.overview;

  return (
    <div className="h-[100vh] flex flex-col w-full">
      {/* The box has to be a column, or the header's height is added to a
          content area that is already the full height of the box and the last
          40px of every long page sits below the clip. */}
      <ContentBox innerClassName={SCROLLABLE_BOX}>
        <Header title={SECTION_TITLES[settingsSection]} />
        <div className={SCROLLABLE_CONTENT}>
          <div className="w-full p-4">
            <SectionComponent />
          </div>
        </div>
      </ContentBox>
    </div>
  );
}

WorkspaceSettings.getLayout = function getLayout(page: React.ReactElement) {
  return <SettingsLayout>{page}</SettingsLayout>;
};
