import { RiCodeSSlashLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
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
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { withoutArchived } from 'modules/product-axis/archive';

import type { ModuleType } from 'common/types';

import { useScope } from 'hooks';

import { useContextStore } from 'store/global-context-provider';

import { DropdownItem } from '../dropdown-item';

/**
 * Which modules an issue changes.
 *
 * Several, because one change often lands in more than one repository, and the
 * whole reason a capability names a list of modules is that this is normal.
 *
 * Every module in the workspace is offered, and the list is not narrowed to the
 * team. A team and a module are different axes on purpose: several teams write
 * in one module, and one team writes in several.
 */
export const ModuleDropdown = observer(
  ({
    value = [],
    onChange,
  }: {
    value?: string[];
    onChange?: (moduleIds: string[]) => void;
  }) => {
    const [open, setOpen] = React.useState(false);
    const { modulesStore } = useContextStore();
    // An archived module is not something to give a new issue.
    const modules: ModuleType[] = withoutArchived<ModuleType>(
      modulesStore.getModules,
    );

    const selected = modules.filter((module) => value.includes(module.id));

    const toggle = (checked: boolean, id: string) => {
      const next = checked
        ? [...new Set([...value, id])]
        : value.filter((moduleId) => moduleId !== id);

      onChange && onChange(next);
    };

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
            {selected.length > 0 ? (
              <div className="inline-flex items-center gap-1 pl-1 min-w-[0px]">
                <RiCodeSSlashLine
                  className="h-5 w-5 text-[9px] mr-2 shrink-0"
                  size={16}
                />
                <div className="truncate">
                  {selected.map((module) => module.name).join(', ')}
                </div>
              </div>
            ) : (
              <div className="inline-flex items-center gap-1 pl-1 text-muted-foreground">
                <RiCodeSSlashLine
                  className="h-5 w-5 text-[9px] mr-2 shrink-0"
                  size={16}
                />
                No module
              </div>
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-72 p-0" align="start">
          <ModuleDropdownContent
            modules={modules}
            value={value}
            toggle={toggle}
          />
        </PopoverContent>
      </Popover>
    );
  },
);

interface ContentProps {
  modules: ModuleType[];
  value: string[];
  toggle: (checked: boolean, id: string) => void;
}

function ModuleDropdownContent({ modules, value, toggle }: ContentProps) {
  useScope('command');

  return (
    <Command>
      <CommandInput placeholder="Set modules..." autoFocus />
      <CommandGroup>
        {modules.map((module: ModuleType, index: number) => (
          <DropdownItem
            key={module.id}
            id={module.id}
            value={module.name}
            index={index}
            onSelect={() => toggle(!value.includes(module.id), module.id)}
          >
            <div className="flex gap-2 items-center">
              <Checkbox
                id={module.name}
                checked={value.includes(module.id)}
                onCheckedChange={(checked: boolean) =>
                  toggle(checked, module.id)
                }
              />
              <label htmlFor={module.name} className="flex gap-2 grow">
                <RiCodeSSlashLine className="h-5 w-5 text-[9px]" size={16} />
                {module.name}
              </label>
            </div>
          </DropdownItem>
        ))}
      </CommandGroup>
    </Command>
  );
}
