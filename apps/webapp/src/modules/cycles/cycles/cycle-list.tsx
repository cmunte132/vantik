import { CyclesModeEnum, CycleStatusEnum } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { Cycle } from '@vantikhq/ui/icons';
import { sort } from 'fast-sort';
import { observer } from 'mobx-react-lite';

import type { CycleType } from 'common/types';

import { useCurrentTeam } from 'hooks/teams';

import { useContextStore } from 'store/global-context-provider';

import { CycleListItem } from './cycle-list-item';

interface CycleListProps {
  onNewCycle: () => void;
}

export const CycleList = observer(({ onNewCycle }: CycleListProps) => {
  const { cyclesStore, teamsStore } = useContextStore();
  const team = useCurrentTeam();

  // Newest first: the cycle a team is running, or about to, is what it came
  // here to act on; finished ones are history and read downwards.
  const cycles: CycleType[] = sort(
    cyclesStore.getCyclesForTeam(team?.id) as CycleType[],
  ).desc((cycle: CycleType) => cycle.number);

  const isManual =
    teamsStore.cyclesModeForTeam(team?.id) === CyclesModeEnum.MANUAL;

  if (cycles.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Cycle size={32} className="text-muted-foreground" />
        <p className="text-muted-foreground">
          {isManual
            ? 'No cycles yet. Create one to start planning work into time boxes.'
            : 'No cycles yet.'}
        </p>
        {isManual && (
          <Button variant="secondary" onClick={onNewCycle}>
            New cycle
          </Button>
        )}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full" id="cycles-list">
      <div className="flex flex-col gap-4 h-full pb-[100px] p-3 pt-0 pl-0">
        {cycles.map((cycle: CycleType) => (
          <CycleListItem
            cycle={cycle}
            key={cycle.id}
            // Where completion would roll unfinished work: the next cycle by
            // number, and only if it has not already run.
            nextCycle={cycles.find(
              (candidate: CycleType) =>
                candidate.number === cycle.number + 1 &&
                candidate.status === CycleStatusEnum.UPCOMING,
            )}
            showControls={isManual}
          />
        ))}
      </div>
    </ScrollArea>
  );
});
