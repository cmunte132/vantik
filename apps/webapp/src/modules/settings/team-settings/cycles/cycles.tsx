import { CyclesModeEnum } from '@vantikhq/types';
import { Input } from '@vantikhq/ui/components/input';
import { Label } from '@vantikhq/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { Switch } from '@vantikhq/ui/components/switch';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { observer } from 'mobx-react-lite';
import * as React from 'react';
import { useDebouncedCallback } from 'use-debounce';

import { SettingSection } from 'modules/settings/setting-section';

import type { TeamType } from 'common/types';

import { useCurrentTeam } from 'hooks/teams';

import { useUpdateTeamPreferencesMutation } from 'services/team';

import { useContextStore } from 'store/global-context-provider';

const DEFAULT_CYCLES_FREQUENCY = 2;
const DEFAULT_UPCOMING_CYCLES = 2;

const MODE_DESCRIPTION: Record<CyclesModeEnum, string> = {
  [CyclesModeEnum.MANUAL]:
    'You create each cycle and decide when it starts and ends, and where ' +
    'unfinished work goes when you complete it.',
  [CyclesModeEnum.AUTO]:
    'Cycles are created, closed and rolled forward on the cadence below. ' +
    'Unfinished work moves to the next cycle on its own.',
};

export const Cycles = observer(() => {
  const team = useCurrentTeam();
  const { teamsStore } = useContextStore();
  const { toast } = useToast();

  const { mutate: updatePreferences } = useUpdateTeamPreferencesMutation({
    // The gated UI — the sidebar's Cycles rows, the issue-sidebar dropdown —
    // reads the store, so writing the response back is what makes it appear
    // and disappear without a reload. The sync socket carries the same change
    // a moment later and lands on an identical row.
    onSuccess: (updatedTeam: TeamType) => {
      teamsStore.update(updatedTeam, updatedTeam.id);
    },
    onError: (error: string) => {
      toast({
        variant: 'destructive',
        title: 'Could not save',
        description: error,
      });
    },
  });

  const preferences = team?.preferences;
  const cyclesEnabled = Boolean(preferences?.cyclesEnabled);
  // Absent for every team that turned cycles on before modes existed. Manual is
  // the mode that does nothing unasked, so it is the safe reading of silence.
  const cyclesMode =
    preferences?.cyclesMode === CyclesModeEnum.AUTO
      ? CyclesModeEnum.AUTO
      : CyclesModeEnum.MANUAL;

  const save = React.useCallback(
    (values: {
      cyclesEnabled?: boolean;
      cyclesMode?: CyclesModeEnum;
      cyclesFrequency?: number;
      upcomingCycles?: number;
    }) => {
      updatePreferences({ teamId: team.id, ...values });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [team?.id],
  );

  // Typing "12" in a number field passes through 1 on the way. Waiting for the
  // typing to stop keeps the intermediate value out of the database.
  const saveCadence = useDebouncedCallback(save, 600);

  if (!team) {
    return null;
  }

  return (
    <SettingSection
      title="Cycles"
      description="Cycles are recurring time boxes — sprints — that issues are
      assigned to. Turning them off hides them everywhere; no cycle and no issue
      assignment is deleted, so turning them back on restores what was there."
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <Switch
            id="cycles-enabled"
            checked={cyclesEnabled}
            onCheckedChange={(checked: boolean) =>
              save({
                cyclesEnabled: checked,
                // Committed alongside the first enable so that every team with
                // cycles on has an explicit mode from then on, rather than
                // leaving the rest of the app to infer one.
                ...(checked && !preferences?.cyclesMode
                  ? { cyclesMode }
                  : undefined),
              })
            }
          />
          <Label htmlFor="cycles-enabled">Enable cycles for this team</Label>
        </div>

        {cyclesEnabled && (
          <>
            <div className="flex flex-col gap-2 max-w-[320px]">
              <Label htmlFor="cycles-mode">Mode</Label>
              <Select
                value={cyclesMode}
                onValueChange={(value: CyclesModeEnum) =>
                  save({ cyclesMode: value })
                }
              >
                <SelectTrigger id="cycles-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CyclesModeEnum.MANUAL}>Manual</SelectItem>
                  <SelectItem value={CyclesModeEnum.AUTO}>Automatic</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground">
                {MODE_DESCRIPTION[cyclesMode]}
              </p>
            </div>

            {cyclesMode === CyclesModeEnum.AUTO && (
              <div className="flex gap-4">
                <div className="flex flex-col gap-2 max-w-[160px]">
                  <Label htmlFor="cycles-frequency">Cycle length</Label>
                  <Input
                    id="cycles-frequency"
                    type="number"
                    min={1}
                    max={12}
                    defaultValue={
                      preferences?.cyclesFrequency ?? DEFAULT_CYCLES_FREQUENCY
                    }
                    onChange={(event) => {
                      const weeks = Number(event.currentTarget.value);
                      if (weeks >= 1) {
                        saveCadence({ cyclesFrequency: weeks });
                      }
                    }}
                  />
                  <p className="text-muted-foreground">Weeks per cycle</p>
                </div>

                <div className="flex flex-col gap-2 max-w-[160px]">
                  <Label htmlFor="upcoming-cycles">Upcoming cycles</Label>
                  <Input
                    id="upcoming-cycles"
                    type="number"
                    min={1}
                    max={12}
                    defaultValue={
                      preferences?.upcomingCycles ?? DEFAULT_UPCOMING_CYCLES
                    }
                    onChange={(event) => {
                      const count = Number(event.currentTarget.value);
                      if (count >= 1) {
                        saveCadence({ upcomingCycles: count });
                      }
                    }}
                  />
                  <p className="text-muted-foreground">
                    How many future cycles to keep ahead
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </SettingSection>
  );
});
