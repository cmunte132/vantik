import type { FilterPickerProps } from './types';

import { observer } from 'mobx-react-lite';

import { IssuePriorityDropdownContent } from 'modules/issues/components';

import { usePriorities } from 'hooks/priorities';

export const IssuePriorityFilter = observer(
  ({ value, onChange, onClose }: FilterPickerProps) => {
    const Priorities = usePriorities();

    return (
      <IssuePriorityDropdownContent
        onChange={(priorities: number[]) => onChange(priorities)}
        onClose={onClose}
        value={value as number[]}
        multiple
        Priorities={Priorities}
      />
    );
  },
);
