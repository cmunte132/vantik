import type { ActionConfig } from '@vantikhq/types';

import { RiAddLine } from '@remixicon/react';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@vantikhq/ui/components/card';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { observer } from 'mobx-react-lite';

import { Header } from 'modules/settings/header';

import { ContentBox } from 'common/layouts/content-box';
import { SettingsLayout } from 'common/layouts/settings-layout';

import { useContextStore } from 'store/global-context-provider';

import { ActionCard } from './action-card';

export const Actions = observer(() => {
  const { actionsStore } = useContextStore();
  const actions = actionsStore.allActions;

  return (
    <div>
      <h2 className="text-lg mb-4"> New action</h2>

      <div className="flex">
        <Card
          className="cursor-pointer"
          onClick={() => {
            window.open('https://docs.vantik.dev/actions/overview', '_blank');
          }}
        >
          <CardHeader>
            <RiAddLine size={24} />
            <CardTitle>Create action</CardTitle>
            <CardDescription>Create from scratch</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <div className="mt-6">
        <h2 className="text-md mb-4"> Installed actions</h2>

        <div className="grid grid-cols-4 gap-4">
          {actions.map((action: ActionConfig) => (
            <ActionCard key={action.slug} action={action} />
          ))}
        </div>
      </div>
    </div>
  );
});

export const ActionsWrapper = () => {
  return <Actions />;
};

ActionsWrapper.getLayout = function getLayout(page: React.ReactElement) {
  return (
    <SettingsLayout>
      <div className="h-[100vh] flex flex-col w-full">
        <ContentBox>
          <Header title="Actions" />
          <ScrollArea className="flex grow h-full">
            <div className="w-full p-6">{page}</div>
          </ScrollArea>
        </ContentBox>
      </div>
    </SettingsLayout>
  );
};
