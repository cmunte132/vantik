import type { FilterPickerProps } from './types';

import { observer } from 'mobx-react-lite';
import React from 'react';

import { IssueLabelDropdownContent } from 'modules/issues/components';

import { useComputedLabels } from 'hooks/labels';

/** Label filters store label names, so one filter spans every team. */
export const IssueLabelFilter = observer(
  ({ value, onChange }: FilterPickerProps) => {
    const [labelSearch, setLabelSearch] = React.useState('');
    const { labels } = useComputedLabels();

    const change = (ids: string[]) => {
      onChange(
        ids
          .map((id) => labels.find((label) => label.id === id)?.name)
          .filter(Boolean),
      );
    };

    const computedValues = value.flatMap(
      (name) => labels.find((label) => label.name === name)?.ids ?? [],
    );

    return (
      <IssueLabelDropdownContent
        value={computedValues}
        onChange={change}
        labels={labels}
        labelSearch={labelSearch}
        setLabelSearch={setLabelSearch}
      />
    );
  },
);
