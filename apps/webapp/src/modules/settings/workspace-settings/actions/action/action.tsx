import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { useParams } from 'next/navigation';

import { Header } from 'modules/settings/header';
import { SettingSection } from 'modules/settings/setting-section';

import { ContentBox } from 'common/layouts/content-box';
import { SettingsLayout } from 'common/layouts/settings-layout';
import { ActionAccessGuard } from 'common/wrappers/action-access-guard';

import { useContextStore } from 'store/global-context-provider';

import { Metadata } from './components/metadata';
import { Configuration } from './configuration';
import { DeleteActionButton } from './delete-action-button';

export const Action = () => {
  const { actionSlug } = useParams<{ actionSlug: string }>();
  const { actionsStore } = useContextStore();
  const action = actionsStore.getAction(actionSlug);

  const metadata = (
    <div className="mt-3 flex gap-2">
      <Metadata />
    </div>
  );

  if (!action) {
    return null;
  }

  return (
    <ContentBox>
      <Header title={action?.name} />
      <ScrollArea className="flex grow h-full">
        <div className="w-full p-6">
          <SettingSection
            title={action.name}
            description={action.description}
            metadata={metadata}
          >
            <Configuration />

            <div className="flex justify-end pt-2">
              <DeleteActionButton id={action.id} />
            </div>
          </SettingSection>
        </div>
      </ScrollArea>
    </ContentBox>
  );
};

Action.getLayout = function getLayout(page: React.ReactElement) {
  return (
    <SettingsLayout>
      <div className="h-[100vh] flex flex-col w-full">
        <ActionAccessGuard>{page}</ActionAccessGuard>
      </div>
    </SettingsLayout>
  );
};
