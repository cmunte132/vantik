import type { FilterPickerProps } from './types';

import { observer } from 'mobx-react-lite';

import { IssueStatusDropdownContent } from 'modules/issues/components';

import { useComputedWorkflows } from 'hooks/workflows';

/** Status filters store workflow names, so one filter spans every team. */
export const IssueStatusFilter = observer(
  ({ value, onChange, onClose }: FilterPickerProps) => {
    const { workflows } = useComputedWorkflows();

    const computedValues = value
      .map((name) => workflows.find((workflow) => workflow.name === name)?.id)
      .filter(Boolean);

    const change = (ids: string[]) => {
      onChange(
        ids
          .map((id) => workflows.find((workflow) => workflow.id === id)?.name)
          .filter(Boolean),
      );
    };

    return (
      <IssueStatusDropdownContent
        onChange={change}
        onClose={onClose}
        workflows={workflows}
        multiple
        value={computedValues}
      />
    );
  },
);
