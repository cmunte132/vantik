import { RiRefreshLine } from '@remixicon/react';
import { CyclesModeEnum, CycleStatusEnum } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { sort } from 'fast-sort';
import { observer } from 'mobx-react-lite';

import type { CycleType } from 'common/types';

import { useCurrentTeam } from 'hooks/teams';

import { useContextStore } from 'store/global-context-provider';

import { AutoCyclesPanel } from './auto-cycles-panel';
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
  const isRunning = Boolean(
    teamsStore.getTeamWithId(team?.id)?.preferences?.cyclesAutoRunning,
  );

  // An automatic team that has never started, or has been stopped and run its
  // last cycle out, gets the cadence summary and a Start button instead of an
  // empty list — the list is not the thing it acts on.
  if (!isManual && !isRunning) {
    return <AutoCyclesPanel running={false} />;
  }

  if (cycles.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <RiRefreshLine size={32} className="text-muted-foreground" />
        <p className="text-muted-foreground">
          No cycles yet. Create one to start planning work into time boxes.
        </p>
        <Button variant="secondary" onClick={onNewCycle}>
          New cycle
        </Button>
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
