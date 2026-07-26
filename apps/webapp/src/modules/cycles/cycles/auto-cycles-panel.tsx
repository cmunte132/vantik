import {
  DEFAULT_CYCLES_FREQUENCY,
  DEFAULT_UPCOMING_CYCLES,
} from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { Cycle } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';

import { useCurrentTeam } from 'hooks/teams';

import { useCreateCyclesMutation, useStopCyclesMutation } from 'services/cycle';

import { useContextStore } from 'store/global-context-provider';

/**
 * Start and Stop for the automatic cadence.
 *
 * A team on this mode does not create cycles; it configures a cadence in
 * settings and turns the machine on. So the only thing to show before it is
 * running is what the cadence says and a button — and once it is running, the
 * way back out.
 */
export const AutoCyclesPanel = observer(({ running }: { running: boolean }) => {
  const team = useCurrentTeam();
  const { teamsStore, cyclesStore } = useContextStore();
  const { toast } = useToast();

  // Through the store, not the node useCurrentTeam memoised: its update
  // replaces the array element, leaving that node detached and frozen.
  const preferences = teamsStore.getTeamWithId(team?.id)?.preferences;
  const weeks = preferences?.cyclesFrequency ?? DEFAULT_CYCLES_FREQUENCY;
  const upcoming = preferences?.upcomingCycles ?? DEFAULT_UPCOMING_CYCLES;

  const { mutate: startCycles, isPending: isStarting } =
    useCreateCyclesMutation({
      onSuccess: (cycles) => {
        // Reloaded rather than written through: the store keeps a cycle's
        // preferences as a JSON string, so the raw API objects do not fit it.
        cyclesStore.load();
        // The Start/Stop state lives in the team preferences. Deliberately not
        // written here: the teams store's update *replaces* the array element,
        // which detaches the node every other component is holding — the team
        // icon and the workflow hooks then read a dead node. The sync socket
        // carries the same preference change a moment later, through the one
        // path that is allowed to do that.
        toast({
          variant: 'success',
          title: 'Cycles started',
          description: `${cycles.length} cycle(s) created on a ${weeks}-week cadence`,
        });
      },
      onError: (error: string) => {
        toast({
          variant: 'destructive',
          title: 'Could not start cycles',
          description: error,
        });
      },
    });

  const { mutate: stopCycles, isPending: isStopping } = useStopCyclesMutation({
    onSuccess: () => {
      cyclesStore.load();
      toast({
        variant: 'success',
        title: 'Cycles stopped',
        description:
          'Upcoming cycles were removed. The current one will finish as planned.',
      });
    },
    onError: (error: string) => {
      toast({
        variant: 'destructive',
        title: 'Could not stop cycles',
        description: error,
      });
    },
  });

  if (running) {
    return (
      <Button
        variant="secondary"
        isLoading={isStopping}
        onClick={() => stopCycles({ teamId: team.id })}
      >
        Stop cycles
      </Button>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <Cycle size={32} className="text-muted-foreground" />
      <p className="text-muted-foreground max-w-[420px] text-center">
        Cycles run automatically for this team: {weeks}-week cycles, with{' '}
        {upcoming} kept ahead. Start them and the system creates, closes and
        rolls them forward from here on.
      </p>
      <Button
        variant="secondary"
        isLoading={isStarting}
        onClick={() => startCycles({ teamId: team.id })}
      >
        Start cycles
      </Button>
    </div>
  );
});
