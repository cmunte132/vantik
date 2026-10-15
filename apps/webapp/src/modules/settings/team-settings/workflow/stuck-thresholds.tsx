import type { StateThreshold } from '@vantikhq/types';

import { Input } from '@vantikhq/ui/components/input';
import { Label } from '@vantikhq/ui/components/label';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { SettingSection } from 'modules/settings/setting-section';

import { useCurrentTeam } from 'hooks/teams';

import {
  useThresholdsQuery,
  useUpdateThresholdOverridesMutation,
} from 'services/team-dashboard';

function hint(threshold: StateThreshold) {
  if (threshold.learnedHours !== null) {
    return `Learned: ${Math.round(threshold.learnedHours)}h from ${
      threshold.sampleCount
    } issues`;
  }

  return `Default: ${Math.round(threshold.defaultHours)}h (not enough history)`;
}

const ThresholdRow = ({
  threshold,
  onSave,
}: {
  threshold: StateThreshold;
  onSave: (stateId: string, hours: number | null) => void;
}) => {
  const saved =
    threshold.overrideHours === null ? '' : String(threshold.overrideHours);
  const [value, setValue] = React.useState(saved);

  // A save, or a change from another tab, replaces what the field shows.
  React.useEffect(() => setValue(saved), [saved]);

  const commit = () => {
    const trimmed = value.trim();

    if (trimmed === saved) {
      return;
    }
    if (trimmed === '') {
      onSave(threshold.stateId, null);
      return;
    }

    // Half-typed or nonsense text goes back to what is saved; it never clears.
    const hours = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : NaN;
    if (!(hours > 0)) {
      setValue(saved);
      return;
    }

    onSave(threshold.stateId, hours);
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col min-w-0">
        <Label htmlFor={`threshold-${threshold.stateId}`}>
          {threshold.name}
        </Label>
        <p className="text-muted-foreground">{hint(threshold)}</p>
      </div>
      <Input
        id={`threshold-${threshold.stateId}`}
        type="text"
        inputMode="decimal"
        className="w-[110px] shrink-0"
        placeholder={String(
          Math.round(threshold.learnedHours ?? threshold.defaultHours),
        )}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
};

export const StuckThresholds = observer(() => {
  const team = useCurrentTeam();
  const { toast } = useToast();
  // Bumped on a failed save, so each field drops its text for the saved value.
  const [resetKey, setResetKey] = React.useState(0);
  const { data: thresholds } = useThresholdsQuery(team?.id);

  const { mutate: save } = useUpdateThresholdOverridesMutation({
    onError: (error: string) => {
      setResetKey((key) => key + 1);
      toast({
        variant: 'destructive',
        title: 'Could not save',
        description: error,
      });
    },
  });

  return (
    <SettingSection
      title="Stuck issue thresholds"
      description="An issue is stuck when it stays in a state longer than this. By default the time is learned from how long your team's issues usually stay there."
    >
      <div className="flex flex-col gap-4 max-w-[500px]">
        {thresholds?.map((threshold) => (
          <ThresholdRow
            key={`${threshold.stateId}-${resetKey}`}
            threshold={threshold}
            onSave={(stateId, hours) =>
              save({ teamId: team.id, overrides: { [stateId]: hours } })
            }
          />
        ))}
        {thresholds?.length === 0 && (
          <p className="text-muted-foreground">
            No states are tracked for stuck issues yet.
          </p>
        )}
      </div>
    </SettingSection>
  );
});
