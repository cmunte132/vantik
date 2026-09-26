import { CommandGroup, CommandItem } from '@vantikhq/ui/components/command';
import { Separator } from '@vantikhq/ui/components/separator';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { useProject } from 'hooks/projects';

import {
  FLAG_FILTER_KEYS,
  VALUE_FILTER_KEYS,
  type FilterKey,
} from 'store/application';

import {
  FLAG_FILTER_ICONS,
  VALUE_FILTER_COMPONENTS,
} from './filter-components';
import { FLAG_FILTERS, VALUE_FILTERS } from './filter-registry';

function MenuItem({
  name,
  icon,
  onSelect,
}: {
  name: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  // The name is the value cmdk searches, so typing "blocked" finds a flag.
  return (
    <CommandItem value={name} className="flex items-center" onSelect={onSelect}>
      {icon}
      {name}
    </CommandItem>
  );
}

export const DefaultFilterDropdown = observer(
  ({ onSelect }: { onSelect: (key: FilterKey) => void }) => {
    const project = useProject();
    const shown = VALUE_FILTER_KEYS.filter(
      (key) => !(project && VALUE_FILTERS[key].hiddenInProject),
    );

    const valueItems = (group: 'issue' | 'axis') =>
      shown
        .filter((key) => VALUE_FILTERS[key].group === group)
        .map((key) => (
          <MenuItem
            key={key}
            name={VALUE_FILTERS[key].name}
            icon={VALUE_FILTER_COMPONENTS[key].icon}
            onSelect={() => onSelect(key)}
          />
        ));

    return (
      <CommandGroup>
        {valueItems('issue')}

        {/*
          The second axis. A team owns issues, and a module owns code, so these
          three answer a question the filters above cannot: which part of the
          software this work touches.
        */}
        <Separator className="my-1" />
        {valueItems('axis')}

        <Separator className="my-1" />
        {FLAG_FILTER_KEYS.map((key) => (
          <MenuItem
            key={key}
            name={FLAG_FILTERS[key].name}
            icon={FLAG_FILTER_ICONS[key]}
            onSelect={() => onSelect(key)}
          />
        ))}
      </CommandGroup>
    );
  },
);
