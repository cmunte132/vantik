import { Button } from '@vantikhq/ui/components/button';
import {
  Command,
  CommandGroup,
  CommandInput,
} from '@vantikhq/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import { FocusLine } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { withoutArchived } from 'modules/product-axis/archive';

import type { CapabilityType } from 'common/types';

import { useScope } from 'hooks';

import { useContextStore } from 'store/global-context-provider';

import { DropdownItem } from '../dropdown-item';

/** What the issue makes the software do. One capability, or none. */
export const CapabilityDropdown = observer(
  ({
    value,
    onChange,
  }: {
    value?: string | null;
    onChange?: (capabilityId: string | null) => void;
  }) => {
    const [open, setOpen] = React.useState(false);
    const { capabilitiesStore } = useContextStore();
    const capabilities: CapabilityType[] = withoutArchived<CapabilityType>(
      capabilitiesStore.getCapabilities,
    );

    const current = capabilities.find((capability) => capability.id === value);

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="link"
            role="combobox"
            aria-expanded={open}
            className={cn(
              'bg-transparent px-0 shadow-none justify-between focus-visible:ring-1 focus-visible:border-primary inline-flex items-center flex-wrap max-w-[200px]',
            )}
          >
            <div
              className={cn(
                'inline-flex items-center gap-1 pl-1 min-w-[0px]',
                !current && 'text-muted-foreground',
              )}
            >
              <FocusLine className="h-5 w-5 text-[9px] mr-2 shrink-0" />
              <div className="truncate">
                {current ? current.name : 'No capability'}
              </div>
            </div>
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-72 p-0" align="start">
          <CapabilityDropdownContent
            capabilities={capabilities}
            onSelect={(capabilityId) => {
              onChange && onChange(capabilityId);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    );
  },
);

interface ContentProps {
  capabilities: CapabilityType[];
  onSelect: (capabilityId: string | null) => void;
}

function CapabilityDropdownContent({ capabilities, onSelect }: ContentProps) {
  useScope('command');

  return (
    <Command>
      <CommandInput placeholder="Set capability..." autoFocus />
      <CommandGroup>
        <DropdownItem
          id="no-capability"
          value="No capability"
          index={0}
          onSelect={() => onSelect(null)}
        >
          <div className="flex gap-2 items-center">
            <FocusLine className="h-5 w-5 text-[9px]" />
            No capability
          </div>
        </DropdownItem>

        {capabilities.map((capability: CapabilityType, index: number) => (
          <DropdownItem
            key={capability.id}
            id={capability.id}
            value={capability.name}
            index={index + 1}
            onSelect={() => onSelect(capability.id)}
          >
            <div className="flex gap-2 items-center">
              <FocusLine className="h-5 w-5 text-[9px]" />
              {capability.name}
            </div>
          </DropdownItem>
        ))}
      </CommandGroup>
    </Command>
  );
}
