import { RiRefreshLine } from '@remixicon/react';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { CommandGroup } from '@vantikhq/ui/components/command';

import type { CycleType } from 'common/types';

import { useScope } from 'hooks';

import { DropdownItem } from '../dropdown-item';

interface CycleDropdownContentProps {
  onChange?: (cycleId: string | string[]) => void;
  cycles: CycleType[];
  onClose: () => void;
  multiple?: boolean;
  value: string | string[];
}

export function CycleDropdownContent({
  onChange,
  cycles,
  onClose,
  multiple = false,
  value,
}: CycleDropdownContentProps) {
  useScope('command');

  const onValueChange = (checked: boolean, id: string) => {
    if (checked && !value.includes(id)) {
      onChange && onChange([...value, id]);
    }

    if (!checked && value.includes(id)) {
      const newIds = [...value];
      const indexToDelete = newIds.indexOf(id);

      newIds.splice(indexToDelete, 1);
      onChange && onChange(newIds);
    }
  };

  return (
    <CommandGroup>
      <DropdownItem
        id="no-cycle"
        value="No Cycle"
        index={0}
        onSelect={() => {
          if (!multiple) {
            onChange && onChange(null);
            onClose();
          } else {
            onValueChange(!value.includes('no-cycle'), 'no-cycle');
          }
        }}
      >
        <div className="flex gap-2 items-center">
          {multiple && (
            <Checkbox
              checked={value.includes('no-cycle')}
              tabIndex={-1}
              className="pointer-events-none"
            />
          )}
          <div className="flex grow">
            <RiRefreshLine size={20} className="mr-2" />
            No Cycle
          </div>
        </div>
      </DropdownItem>
      {cycles.map((cycle: CycleType, index: number) => {
        return (
          <DropdownItem
            key={cycle.id}
            id={cycle.id}
            value={cycle.name}
            index={index + 1}
            onSelect={(currentValue: string) => {
              if (!multiple) {
                onChange && onChange(currentValue);
                onClose();
              } else {
                onValueChange(!value.includes(currentValue), cycle.id);
              }
            }}
          >
            <div className="flex gap-2 items-center">
              {multiple && (
                <Checkbox
                  checked={value.includes(cycle.id)}
                  tabIndex={-1}
                  className="pointer-events-none"
                />
              )}
              <label className="flex gap-2 grow">
                <RiRefreshLine className="h-5 w-5 text-[9px]" size={16} />

                {cycle.name}
              </label>
            </div>
          </DropdownItem>
        );
      })}
    </CommandGroup>
  );
}
