import { RiDeleteBinLine, RiMoreLine } from '@remixicon/react';
import { CycleStatusEnum } from '@vantikhq/types';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { format } from 'date-fns';
import { observer } from 'mobx-react-lite';
import Link from 'next/link';
import * as React from 'react';

import type { CycleType } from 'common/types';

import { useCurrentTeam } from 'hooks/teams';
import { useCurrentWorkspace } from 'hooks/workspace';

import { useStartCycleMutation } from 'services/cycle';

import { CompleteCycleDialog } from './complete-cycle-dialog';
import { DeleteCycleAlert } from './delete-cycle-alert';
import { CycleProgress } from '../cycle-view/cycle-progress';

interface CycleListItemProps {
  cycle: CycleType;
  /** The cycle unfinished work would roll into. Absent when there is none. */
  nextCycle?: CycleType;
  /** Manual-mode teams drive their own cycles; automatic ones only watch. */
  showControls: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  [CycleStatusEnum.UPCOMING]: 'Upcoming',
  [CycleStatusEnum.CURRENT]: 'Current',
  [CycleStatusEnum.COMPLETED]: 'Completed',
};

export const CycleListItem = observer(
  ({ cycle, nextCycle, showControls }: CycleListItemProps) => {
    const team = useCurrentTeam();
    const workspace = useCurrentWorkspace();
    const { toast } = useToast();

    const [completeOpen, setCompleteOpen] = React.useState(false);
    const [deleteOpen, setDeleteOpen] = React.useState(false);

    const { mutate: startCycle, isPending: isStarting } = useStartCycleMutation(
      {
        // The status change arrives through the sync socket, which shapes the
        // cycle for the store; writing the raw response here would throw.
        // The server refuses a second current cycle; saying so plainly is the
        // difference between a rule and a button that does nothing.
        onError: (error: string) => {
          toast({
            variant: 'destructive',
            title: 'Could not start the cycle',
            description: error,
          });
        },
      },
    );

    const isUpcoming = cycle.status === CycleStatusEnum.UPCOMING;
    const isCurrent = cycle.status === CycleStatusEnum.CURRENT;

    return (
      <div className="bg-background-2 p-4 rounded-md flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Link
                href={`/${workspace?.slug}/team/${team?.identifier}/cycles/${cycle.number}`}
                className="text-md hover:underline"
              >
                {cycle.name}
              </Link>
              <Badge variant="secondary">
                {STATUS_LABEL[cycle.status] ?? cycle.status}
              </Badge>
            </div>

            {cycle.startDate && cycle.endDate && (
              <span className="text-muted-foreground">
                {format(new Date(cycle.startDate), 'PP')} –{' '}
                {format(new Date(cycle.endDate), 'PP')}
              </span>
            )}
          </div>

          {showControls && (
            <div className="flex items-center gap-2">
              {isUpcoming && (
                <Button
                  variant="secondary"
                  isLoading={isStarting}
                  onClick={() => startCycle({ cycleId: cycle.id })}
                >
                  Start cycle
                </Button>
              )}

              {isCurrent && (
                <Button
                  variant="secondary"
                  onClick={() => setCompleteOpen(true)}
                >
                  Complete cycle
                </Button>
              )}

              {/* Upcoming only: a cycle a team has run is a record of what it
                  did, and the server refuses to delete one. */}
              {isUpcoming && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm">
                      <RiMoreLine size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setDeleteOpen(true)}>
                      <div className="flex items-center gap-1">
                        <RiDeleteBinLine size={16} /> Delete
                      </div>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        {!isUpcoming && <CycleProgress id={cycle.id} onlyGraph />}

        {completeOpen && (
          <CompleteCycleDialog
            cycle={cycle}
            nextCycle={nextCycle}
            open={completeOpen}
            setOpen={setCompleteOpen}
          />
        )}

        {deleteOpen && (
          <DeleteCycleAlert
            cycle={cycle}
            open={deleteOpen}
            setOpen={setDeleteOpen}
          />
        )}
      </div>
    );
  },
);
