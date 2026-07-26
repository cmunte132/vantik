import { CyclesModeEnum, CycleStatusEnum } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import type { CycleType } from 'common/types';

import { useCycles } from 'hooks/cycles';
import { useCurrentTeam } from 'hooks/teams';

import { useStartCycleMutation } from 'services/cycle';

import { useContextStore } from 'store/global-context-provider';

import { CompleteCycleDialog } from '../cycles/complete-cycle-dialog';

/**
 * Start and Complete on the cycle's own page.
 *
 * The same two actions the list carries, because the cycle view is where
 * somebody ends up when they are actually working the cycle, and going back to
 * the list to close it is a step with no purpose.
 */
export const CycleActions = observer(({ cycle }: { cycle: CycleType }) => {
  const team = useCurrentTeam();
  const { cycles } = useCycles();
  const { teamsStore } = useContextStore();
  const { toast } = useToast();
  const [completeOpen, setCompleteOpen] = React.useState(false);

  const { mutate: startCycle, isPending } = useStartCycleMutation({
    // The sync socket carries the status change, correctly shaped for the store.
    onError: (error: string) => {
      toast({
        variant: 'destructive',
        title: 'Could not start the cycle',
        description: error,
      });
    },
  });

  if (teamsStore.cyclesModeForTeam(team?.id) !== CyclesModeEnum.MANUAL) {
    return null;
  }

  const nextCycle = cycles.find(
    (candidate: CycleType) =>
      candidate.number === cycle.number + 1 &&
      candidate.status === CycleStatusEnum.UPCOMING,
  );

  return (
    <>
      {cycle.status === CycleStatusEnum.UPCOMING && (
        <Button
          variant="secondary"
          size="sm"
          isLoading={isPending}
          onClick={() => startCycle({ cycleId: cycle.id })}
        >
          Start cycle
        </Button>
      )}

      {cycle.status === CycleStatusEnum.CURRENT && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setCompleteOpen(true)}
        >
          Complete cycle
        </Button>
      )}

      {completeOpen && (
        <CompleteCycleDialog
          cycle={cycle}
          nextCycle={nextCycle}
          open={completeOpen}
          setOpen={setCompleteOpen}
        />
      )}
    </>
  );
});
