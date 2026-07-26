import { UnfinishedDestinationEnum } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import type { CycleType } from 'common/types';

import { useCompleteCycleMutation } from 'services/cycle';

import { useContextStore } from 'store/global-context-provider';

import { useCycleIssueCounts } from '../use-cycle-issue-counts';

interface CompleteCycleDialogProps {
  cycle: CycleType;
  nextCycle?: CycleType;
  open: boolean;
  setOpen: (value: boolean) => void;
}

export const CompleteCycleDialog = observer(
  ({ cycle, nextCycle, open, setOpen }: CompleteCycleDialogProps) => {
    const { cyclesStore, issuesStore } = useContextStore();
    const { toast } = useToast();
    const { finished, unfinished } = useCycleIssueCounts(cycle.id);

    // Defaults to the next cycle when there is one, because carrying work
    // forward is what a team completing a sprint usually means to do; without
    // one the choice is not offered at all rather than silently switched.
    const [destination, setDestination] =
      React.useState<UnfinishedDestinationEnum>(
        UnfinishedDestinationEnum.NEXT_CYCLE,
      );

    React.useEffect(() => {
      setDestination(
        nextCycle
          ? UnfinishedDestinationEnum.NEXT_CYCLE
          : UnfinishedDestinationEnum.BACKLOG,
      );
    }, [nextCycle, open]);

    const { mutate: complete, isPending } = useCompleteCycleMutation({
      onSuccess: () => {
        // The issues that moved are not in this response, and the cycle a
        // person is looking at is exactly the one whose membership changed.
        issuesStore.load();
        cyclesStore.load();
        setOpen(false);
        toast({
          variant: 'success',
          title: 'Cycle completed',
          description:
            unfinished === 0
              ? `${cycle.name} is closed`
              : destination === UnfinishedDestinationEnum.NEXT_CYCLE
                ? `${unfinished} unfinished issue(s) moved to ${nextCycle?.name}`
                : `${unfinished} unfinished issue(s) went back to the backlog`,
        });
      },
      onError: (error: string) => {
        toast({
          variant: 'destructive',
          title: 'Could not complete the cycle',
          description: error,
        });
      },
    });

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Complete {cycle.name}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex gap-6">
              <div className="flex flex-col">
                <span className="font-mono text-lg">{finished}</span>
                <span className="text-muted-foreground">done</span>
              </div>
              <div className="flex flex-col">
                <span className="font-mono text-lg">{unfinished}</span>
                <span className="text-muted-foreground">unfinished</span>
              </div>
            </div>

            {unfinished > 0 && (
              <div className="flex flex-col gap-2">
                <span>Move the unfinished issues to</span>

                <DestinationOption
                  selected={
                    destination === UnfinishedDestinationEnum.NEXT_CYCLE
                  }
                  disabled={!nextCycle}
                  onSelect={() =>
                    setDestination(UnfinishedDestinationEnum.NEXT_CYCLE)
                  }
                  title={nextCycle ? nextCycle.name : 'The next cycle'}
                  hint={
                    nextCycle
                      ? 'They carry over and start the next cycle already in it'
                      : 'There is no upcoming cycle to move them into yet'
                  }
                />

                <DestinationOption
                  selected={destination === UnfinishedDestinationEnum.BACKLOG}
                  onSelect={() =>
                    setDestination(UnfinishedDestinationEnum.BACKLOG)
                  }
                  title="The backlog"
                  hint="They leave the cycle and belong to none"
                />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                isLoading={isPending}
                onClick={() =>
                  complete({
                    cycleId: cycle.id,
                    unfinishedDestination: destination,
                  })
                }
              >
                Complete cycle
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  },
);

interface DestinationOptionProps {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
}

function DestinationOption({
  selected,
  disabled,
  onSelect,
  title,
  hint,
}: DestinationOptionProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex flex-col items-start rounded-md border p-3 text-left transition-colors',
        selected
          ? 'border-primary bg-background-3'
          : 'border-transparent bg-background-3',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span>{title}</span>
      <span className="text-muted-foreground">{hint}</span>
    </button>
  );
}
