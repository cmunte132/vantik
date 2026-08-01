import { RiAddLine, RiCloseLine, RiFocus3Line } from '@remixicon/react';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
} from '@vantikhq/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';

import type { CapabilityType } from 'common/types';
import { workspaceHref } from 'common/workspace-href';

import { useScope } from 'hooks';

import {
  useCreateCapabilityMutation,
  useUpdateCapabilityMutation,
} from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

import { withoutArchived } from './archive';

/**
 * The capabilities that this module helps to make.
 *
 * A capability holds the list of its modules, and a module holds no list of
 * capabilities. So this control writes to the capability, and the module page
 * reads the graph the other way round.
 *
 * The same control adds an existing capability and makes a new one. A
 * capability nearly always needs more than one module, so the first question
 * is whether one exists already. The search asks it, and the row at the end
 * makes a new capability when the answer is no.
 */
export const CapabilityPicker = observer(
  ({ moduleId }: { moduleId: string }) => {
    const { capabilitiesStore } = useContextStore();
    const {
      query: { workspaceSlug },
    } = useRouter();

    const { mutate: createCapability } = useCreateCapabilityMutation({});
    const { mutate: updateCapability } = useUpdateCapabilityMutation({});

    const onModule: CapabilityType[] =
      capabilitiesStore.getCapabilitiesForModules([moduleId]);

    const addable: CapabilityType[] = withoutArchived<CapabilityType>(
      capabilitiesStore.getCapabilities,
    ).filter((capability) => !capability.moduleIds.includes(moduleId));

    const attach = (capability: CapabilityType) =>
      updateCapability({
        capabilityId: capability.id,
        moduleIds: [...capability.moduleIds, moduleId],
      });

    // The capability stays. It only stops naming this module, because the code
    // moved or because it never lived here.
    const detach = (capability: CapabilityType) =>
      updateCapability({
        capabilityId: capability.id,
        moduleIds: capability.moduleIds.filter((id) => id !== moduleId),
      });

    return (
      <>
        {onModule.map((capability) => (
          <div
            key={capability.id}
            className="flex items-center gap-2 border-b border-border px-4 py-2"
          >
            <RiFocus3Line size={14} className="shrink-0" />
            <NextLink
              href={workspaceHref(workspaceSlug, 'capability', capability.id)}
              className="flex-1 truncate hover:underline"
            >
              {capability.name}
            </NextLink>
            <Badge variant="outline">{capability.status ?? 'planned'}</Badge>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Take ${capability.name} off this module`}
              onClick={() => detach(capability)}
            >
              <RiCloseLine size={14} />
            </Button>
          </div>
        ))}

        <div className="px-4 py-2">
          <AddCapability
            options={addable}
            onAttach={attach}
            onCreate={(name) =>
              createCapability({ name, moduleIds: [moduleId] })
            }
          />
        </div>
      </>
    );
  },
);

function AddCapability({
  options,
  onAttach,
  onCreate,
}: {
  options: CapabilityType[];
  onAttach: (capability: CapabilityType) => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" className="gap-1">
          <RiAddLine size={14} />
          Add a capability
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <AddCapabilityContent
          options={options}
          onAttach={(capability) => {
            onAttach(capability);
            setOpen(false);
          }}
          onCreate={(name) => {
            onCreate(name);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function AddCapabilityContent({
  options,
  onAttach,
  onCreate,
}: {
  options: CapabilityType[];
  onAttach: (capability: CapabilityType) => void;
  onCreate: (name: string) => void;
}) {
  useScope('command');

  const [search, setSearch] = React.useState('');
  const typed = search.trim();

  // An exact name that exists already must not become a second capability with
  // the same name. The list above offers that one instead.
  const duplicate = options.some(
    (capability) => capability.name.toLowerCase() === typed.toLowerCase(),
  );

  return (
    <Command>
      <CommandInput
        placeholder="Find or name a capability..."
        autoFocus
        value={search}
        onValueChange={setSearch}
      />
      <CommandGroup>
        {options.map((capability) => (
          <CommandItem
            key={capability.id}
            value={capability.name}
            onSelect={() => onAttach(capability)}
          >
            <div className="flex w-full items-center gap-2">
              <span className="flex-1 truncate">{capability.name}</span>
              <span className="text-muted-foreground">
                {capability.moduleIds.length === 1
                  ? '1 module'
                  : `${capability.moduleIds.length} modules`}
              </span>
            </div>
          </CommandItem>
        ))}

        {typed && !duplicate && (
          <CommandItem
            // The value carries the text so cmdk never filters this row out.
            value={typed}
            onSelect={() => onCreate(typed)}
          >
            <div className="flex w-full items-center gap-2">
              <RiAddLine size={14} className="shrink-0" />
              <span className="truncate">
                Make <span className="font-medium">{typed}</span>
              </span>
            </div>
          </CommandItem>
        )}
      </CommandGroup>

      {options.length === 0 && !typed && (
        <p className="px-3 py-2 text-muted-foreground">
          No capability exists yet. Type a name to make the first one.
        </p>
      )}
    </Command>
  );
}
