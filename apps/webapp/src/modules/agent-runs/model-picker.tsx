import { RiArrowDownSLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
} from '@vantikhq/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import * as React from 'react';

import { DropdownItem } from 'modules/issues/components/issue-metadata/dropdown-item';

import { useScope } from 'hooks';

export interface ModelOption {
  id: string;
  label: string;
}

/**
 * A model menu you can type into.
 *
 * A provider's list is the menu, and one provider (OpenRouter) answers with
 * several hundred models, which a plain select makes you scroll through. Typing
 * filters on the id and the label both.
 *
 * `noneLabel` adds a first entry that picks nothing, for a caller where
 * nothing has a meaning of its own, such as the workspace default.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  placeholder = 'Pick a model',
  noneLabel,
}: {
  models: ModelOption[];
  value?: string;
  onChange: (model: string | undefined) => void;
  placeholder?: string;
  noneLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = models.find((model) => model.id === value);

  const pick = (model: string | undefined) => {
    setOpen(false);
    onChange(model);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between gap-2 font-normal"
        >
          <span
            className={
              current || value ? 'truncate' : 'truncate text-muted-foreground'
            }
          >
            {current?.label ?? value ?? noneLabel ?? placeholder}
          </span>
          <RiArrowDownSLine size={16} className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] min-w-72 p-0"
        align="start"
      >
        {open && (
          <ModelList models={models} noneLabel={noneLabel} onSelect={pick} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ModelList({
  models,
  noneLabel,
  onSelect,
}: {
  models: ModelOption[];
  noneLabel?: string;
  onSelect: (model: string | undefined) => void;
}) {
  useScope('command');

  return (
    <Command>
      <CommandInput
        placeholder={`Find one of ${models.length} models...`}
        autoFocus
      />
      <CommandEmpty>No model matches.</CommandEmpty>
      <CommandGroup className="max-h-72 overflow-y-auto">
        {noneLabel && (
          <DropdownItem
            id="__none__"
            value={noneLabel}
            index={0}
            onSelect={() => onSelect(undefined)}
          >
            <span>{noneLabel}</span>
          </DropdownItem>
        )}
        {models.map((model, index) => (
          <DropdownItem
            key={model.id}
            id={model.id}
            value={`${model.id} ${model.label}`}
            index={index + 1}
            onSelect={() => onSelect(model.id)}
          >
            <span className="truncate">{model.label}</span>
          </DropdownItem>
        ))}
      </CommandGroup>
    </Command>
  );
}
