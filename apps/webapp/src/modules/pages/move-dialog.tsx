import { Button } from '@vantikhq/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import type { PageType } from 'common/types';

import { useMoveEntriesMutation } from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

interface MoveFactsDialogProps {
  entryIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page the facts are on now. The list does not offer it. */
  fromPageId?: string | null;
}

/**
 * A person picks the page to file facts under. The fact keeps its content,
 * status and proof, and the server records the move on its trail.
 */
export const MoveFactsDialog = observer(
  ({ entryIds, open, onOpenChange, fromPageId }: MoveFactsDialogProps) => {
    const { pagesStore } = useContextStore();
    const [pageId, setPageId] = React.useState<string>();
    const [error, setError] = React.useState<string | null>(null);
    const { mutate: move, isPending } = useMoveEntriesMutation({
      onMutate: () => setError(null),
      onSuccess: () => close(),
      onError: setError,
    });

    const close = () => {
      setPageId(undefined);
      setError(null);
      onOpenChange(false);
    };

    const pages: PageType[] = [...pagesStore.getPages]
      .filter((page: PageType) => page.id !== fromPageId)
      .sort((a: PageType, b: PageType) => a.title.localeCompare(b.title));
    const count = entryIds.length;

    return (
      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent className="p-0 gap-0 min-w-[min(460px,calc(100vw-32px))] sm:max-w-[460px]">
          <DialogHeader className="text-left px-5 pt-5 pb-3">
            <DialogTitle className="font-normal">
              {count === 1 ? 'Move the fact' : `Move ${count} facts`} to a page
            </DialogTitle>
            <p className="text-muted-foreground">
              Agents use {count === 1 ? 'it' : 'them'} the same way after the
              move. Only the page {count === 1 ? 'it is' : 'they are'} filed
              under changes.
            </p>
          </DialogHeader>

          <div className="px-5 pb-5 flex flex-col gap-3">
            <Select value={pageId} onValueChange={setPageId}>
              <SelectTrigger>
                <SelectValue placeholder="The page it belongs on" />
              </SelectTrigger>
              <SelectContent className="max-h-[300px]">
                {pages.map((page) => (
                  <SelectItem key={page.id} value={page.id}>
                    {page.title || 'Untitled page'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {error && <span className="text-destructive">{error}</span>}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!pageId || isPending}
                onClick={() => pageId && move({ entryIds, pageId })}
              >
                Move
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  },
);
