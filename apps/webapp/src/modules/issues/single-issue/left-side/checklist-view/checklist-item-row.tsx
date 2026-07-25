import { Button } from '@vantikhq/ui/components/button';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { Input } from '@vantikhq/ui/components/input';
import { DeleteLine } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import * as React from 'react';

import type { ChecklistItemType } from 'common/types';

import {
  useDeleteChecklistItemMutation,
  useUpdateChecklistItemMutation,
} from 'services/checklist-items';

interface ChecklistItemRowProps {
  checklistItem: ChecklistItemType;
}

export function ChecklistItemRow({ checklistItem }: ChecklistItemRowProps) {
  const [editing, setEditing] = React.useState(false);
  const [body, setBody] = React.useState(checklistItem.body);

  const { mutate: updateChecklistItem } = useUpdateChecklistItemMutation({});
  const { mutate: deleteChecklistItem } = useDeleteChecklistItemMutation({});

  // The row is driven by the synced store, so an edit landing from another
  // client while this one sits idle should win.
  React.useEffect(() => {
    if (!editing) {
      setBody(checklistItem.body);
    }
  }, [checklistItem.body, editing]);

  const onToggle = (completed: boolean) => {
    updateChecklistItem({
      checklistItemId: checklistItem.id,
      issueId: checklistItem.issueId,
      completed,
    });
  };

  const commitBody = () => {
    setEditing(false);
    const trimmed = body.trim();

    if (!trimmed || trimmed === checklistItem.body) {
      setBody(checklistItem.body);
      return;
    }

    updateChecklistItem({
      checklistItemId: checklistItem.id,
      issueId: checklistItem.issueId,
      body: trimmed,
    });
  };

  return (
    <div className="group flex items-center gap-2 py-1 pl-3 pr-2 rounded hover:bg-grayAlpha-100">
      <Checkbox
        checked={checklistItem.completed}
        onCheckedChange={(checked) => onToggle(!!checked)}
      />

      {editing ? (
        <Input
          value={body}
          autoFocus
          className="h-7 grow"
          onChange={(e) => setBody(e.target.value)}
          onBlur={commitBody}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitBody();
            }
            if (e.key === 'Escape') {
              setBody(checklistItem.body);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={cn(
            'grow text-left text-sm py-1',
            checklistItem.completed && 'line-through text-muted-foreground',
          )}
          onClick={() => setEditing(true)}
        >
          {checklistItem.body}
        </button>
      )}

      <Button
        variant="ghost"
        size="xs"
        className="opacity-0 group-hover:opacity-100"
        onClick={() =>
          deleteChecklistItem({ checklistItemId: checklistItem.id })
        }
      >
        <DeleteLine size={14} />
      </Button>
    </div>
  );
}
