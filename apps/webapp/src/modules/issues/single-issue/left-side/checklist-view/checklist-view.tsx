import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
} from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@vantikhq/ui/components/collapsible';
import { Input } from '@vantikhq/ui/components/input';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import type { ChecklistItemType } from 'common/types';

import { useCreateChecklistItemMutation } from 'services/checklist-items';

import { useContextStore } from 'store/global-context-provider';

import { ChecklistItemRow } from './checklist-item-row';

interface ChecklistViewProps {
  issueId: string;
}

export const ChecklistView = observer(({ issueId }: ChecklistViewProps) => {
  const { checklistItemsStore } = useContextStore();
  const [isOpen, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [body, setBody] = React.useState('');

  const { mutate: createChecklistItem } = useCreateChecklistItemMutation({});

  const checklistItems: ChecklistItemType[] =
    checklistItemsStore.getChecklistItems(issueId);
  const completedCount = checklistItems.filter(
    (item: ChecklistItemType) => item.completed,
  ).length;

  // A list that already has criteria is the point of the section, so show it
  // open rather than making the reader hunt for it.
  React.useEffect(() => {
    if (checklistItems.length > 0) {
      setOpen(true);
    }
  }, [checklistItems.length]);

  const commitNewItem = () => {
    const trimmed = body.trim();

    if (trimmed) {
      createChecklistItem({ issueId, body: trimmed });
    }

    setBody('');
    setAdding(false);
  };

  const startAdding = () => {
    setOpen(true);
    setAdding(true);
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setOpen} className="w-full py-2">
      <div className="flex justify-between px-6">
        <CollapsibleTrigger asChild>
          <div className="flex items-center">
            <Button variant="link" className="px-0 text-md">
              Definition of Done
              {isOpen ? (
                <RiArrowDownSLine size={16} className="ml-1" />
              ) : (
                <RiArrowRightSLine size={16} className="ml-1" />
              )}
            </Button>

            {checklistItems.length > 0 && (
              <div className="px-2 ml-1 rounded-sm bg-grayAlpha-100 text-foreground">
                {completedCount}/{checklistItems.length}
              </div>
            )}
          </div>
        </CollapsibleTrigger>

        <Button variant="ghost" size="xs" onClick={startAdding}>
          <RiAddLine size={16} />
        </Button>
      </div>

      {checklistItems.length > 0 && (
        <div className="px-6 pt-2">
          <div className="h-1 w-full overflow-hidden rounded bg-grayAlpha-100">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: `${(completedCount / checklistItems.length) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      <CollapsibleContent>
        <div className="pt-1 px-3">
          {checklistItems.map((item: ChecklistItemType) => (
            <ChecklistItemRow key={item.id} checklistItem={item} />
          ))}

          {adding && (
            <div className="flex items-center gap-2 py-1 pl-3 pr-2">
              <Input
                value={body}
                autoFocus
                placeholder="Add a criterion..."
                className="h-7 grow"
                onChange={(e) => setBody(e.target.value)}
                onBlur={commitNewItem}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    // Committing on Enter without closing lets a whole list be
                    // typed in one go.
                    const trimmed = body.trim();
                    if (trimmed) {
                      createChecklistItem({ issueId, body: trimmed });
                    }
                    setBody('');
                  }
                  if (e.key === 'Escape') {
                    setBody('');
                    setAdding(false);
                  }
                }}
              />
            </div>
          )}

          {checklistItems.length === 0 && !adding && (
            <div className="pl-3 py-1 text-sm text-muted-foreground">
              No criteria yet.
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
