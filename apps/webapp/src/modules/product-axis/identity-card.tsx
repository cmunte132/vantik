import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vantikhq/ui/components/alert-dialog';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
// There is no archive icon in the set. `Inbox` is the nearest picture of a box
// that work goes into, and the label beside it carries the meaning.
import { DeleteLine, Inbox } from '@vantikhq/ui/icons';
import * as React from 'react';

import { ARCHIVED_STATUS } from './archive';
import { AxisIconPicker, type AxisIconValue } from './axis-icon';

/**
 * What a product or a module *is*: its name, its icon, and the button that ends
 * it.
 *
 * The same block on both pages, because both answer the same question and a
 * person should not have to learn two layouts for one idea.
 */
export function IdentityCard({
  kind,
  name,
  icon,
  color,
  description,
  status,
  onRename,
  onIcon,
  onArchive,
  onDelete,
  deleteWarning,
  error,
}: AxisIconValue & {
  kind: 'product' | 'module';
  name: string;
  description?: string | null;
  status?: string | null;
  onRename: (name: string) => void;
  onIcon: (value: AxisIconValue) => void;
  onArchive: (archive: boolean) => void;
  onDelete: () => void;
  deleteWarning: string;
  error?: string;
}) {
  const [draft, setDraft] = React.useState(name);
  const [confirming, setConfirming] = React.useState(false);
  const archived = status === ARCHIVED_STATUS;

  // The name can change under this component when somebody else edits it, and a
  // draft that ignores that would quietly put the old name back on the next
  // keystroke.
  React.useEffect(() => setDraft(name), [name]);

  const commit = () => {
    const next = draft.trim();

    if (next && next !== name) {
      onRename(next);
    } else {
      setDraft(name);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <AxisIconPicker
          kind={kind}
          name={name}
          icon={icon}
          color={color}
          onChange={onIcon}
        />

        <Input
          value={draft}
          aria-label={`${kind === 'product' ? 'Product' : 'Module'} name`}
          className="text-base font-medium"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
              event.currentTarget.blur();
            }

            if (event.key === 'Escape') {
              setDraft(name);
              event.currentTarget.blur();
            }
          }}
        />

        {/*
          Archive sits before delete because it is the one a person wants far
          more often. Work on a product stops; the product and its issues stay
          worth reading.
        */}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 text-muted-foreground"
          onClick={() => onArchive(!archived)}
        >
          <Inbox size={14} />
          {archived ? 'Restore' : 'Archive'}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="gap-1 text-muted-foreground"
          onClick={() => setConfirming(true)}
        >
          <DeleteLine size={14} />
          Delete
        </Button>
      </div>

      {archived && (
        <p className="text-muted-foreground">
          <Badge variant="outline">archived</Badge> This {kind} is out of the
          sidebar and out of every picker. Its issues and its history stay.
        </p>
      )}

      {description && <p className="text-muted-foreground">{description}</p>}
      {error && <p className="text-destructive">{error}</p>}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>{deleteWarning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
