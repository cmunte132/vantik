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
import { useToast } from '@vantikhq/ui/components/use-toast';
import { observer } from 'mobx-react-lite';

import type { CycleType } from 'common/types';

import { useDeleteCycleMutation } from 'services/cycle';

import { useContextStore } from 'store/global-context-provider';

import { useCycleIssueCounts } from '../use-cycle-issue-counts';

interface DeleteCycleAlertProps {
  cycle: CycleType;
  open: boolean;
  setOpen: (value: boolean) => void;
}

export const DeleteCycleAlert = observer(
  ({ cycle, open, setOpen }: DeleteCycleAlertProps) => {
    const { cyclesStore, issuesStore } = useContextStore();
    const { toast } = useToast();
    const { total } = useCycleIssueCounts(cycle.id);

    const { mutate: deleteCycle } = useDeleteCycleMutation({
      onSuccess: () => {
        cyclesStore.deleteById(cycle.id);
        // The issues survive the cycle, but their membership does not.
        issuesStore.load();
        setOpen(false);
      },
      onError: (error: string) => {
        toast({
          variant: 'destructive',
          title: 'Could not delete the cycle',
          description: error,
        });
      },
    });

    return (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {cycle.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {total > 0
                ? `The ${total} issue(s) planned into it stay, but they will no longer belong to a cycle.`
                : 'The cycle has no issues in it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteCycle({ cycleId: cycle.id })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  },
);
