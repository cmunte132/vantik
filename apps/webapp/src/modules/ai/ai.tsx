import { Button } from '@vantikhq/ui/components/button';
import { AddLine } from '@vantikhq/ui/icons';
import { AI as AII } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';

import { useContextStore } from 'store/global-context-provider';

import { Conversation } from './conversation';
import { AIHistoryDropdown } from './history-dropdown';

export const AI = observer(() => {
  const { commonStore } = useContextStore();

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center gap-2 p-3 px-5 font-mono">
        <div className="flex gap-2">
          <AII />
          Vantik AI
        </div>

        <div className="flex gap-1 items-center">
          <Button
            variant="ghost"
            onClick={() => {
              commonStore.update({ currentConversationId: undefined });
            }}
          >
            <AddLine size={16} />
          </Button>

          <AIHistoryDropdown />
        </div>
      </div>

      <div className="grow overflow-hidden">
        <Conversation />
      </div>
    </div>
  );
});
