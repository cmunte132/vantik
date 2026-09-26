import type { FilterPickerProps } from './types';

import { observer } from 'mobx-react-lite';

import { CycleDropdownContent } from 'modules/issues/components';

import { useCycles } from 'hooks/cycles';

export const IssueCycleFilter = observer(
  ({ value, onChange, onClose }: FilterPickerProps) => {
    const { cycles } = useCycles();

    return (
      <CycleDropdownContent
        onChange={(ids: string[]) => onChange(ids)}
        onClose={onClose}
        value={value as string[]}
        multiple
        cycles={cycles}
      />
    );
  },
);
