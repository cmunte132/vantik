import { RiSideBarLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';

import { useContextStore } from 'store/global-context-provider';

export const SidebarExpand = observer(() => {
  const { applicationStore } = useContextStore();

  return (
    <>
      <Button
        variant="link"
        size="sm"
        onClick={() => {
          applicationStore.updateSideBar(!applicationStore.sidebarCollapsed);
        }}
      >
        <RiSideBarLine size={20} />
      </Button>
    </>
  );
});
