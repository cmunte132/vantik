import { CyclesModeEnum } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { AddLine } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { useCurrentTeam } from 'hooks/teams';

import { useContextStore } from 'store/global-context-provider';

import { AutoCyclesPanel } from './auto-cycles-panel';
import { CycleList } from './cycle-list';
import { NewCycleDialog } from './new-cycle-dialog';
import { Header } from '../header';

const CyclesView = observer(() => {
  const team = useCurrentTeam();
  const { teamsStore } = useContextStore();
  const [newCycleOpen, setNewCycleOpen] = React.useState(false);

  // Automatic teams get a read-only list: their cycles are created and closed
  // on a cadence, and a New cycle button here would cut across it. What they
  // get instead is the way to turn that cadence off.
  const isManual =
    teamsStore.cyclesModeForTeam(team?.id) === CyclesModeEnum.MANUAL;
  const isAutoRunning =
    !isManual &&
    Boolean(teamsStore.getTeamWithId(team?.id)?.preferences?.cyclesAutoRunning);

  return (
    <MainLayout
      header={
        <Header
          title="All cycles"
          actions={
            <>
              {isManual && (
                <Button
                  variant="secondary"
                  className="gap-1"
                  onClick={() => setNewCycleOpen(true)}
                >
                  <AddLine size={14} />
                  New cycle
                </Button>
              )}
              {isAutoRunning && <AutoCyclesPanel running />}
            </>
          }
        />
      }
    >
      <main className={cn('p-3 pt-0 pl-3 h-[calc(100vh_-_48px)]')}>
        <CycleList onNewCycle={() => setNewCycleOpen(true)} />
      </main>

      {isManual && (
        <NewCycleDialog open={newCycleOpen} setOpen={setNewCycleOpen} />
      )}
    </MainLayout>
  );
});

export const Cycles = withApplicationStore(CyclesView);

Cycles.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
