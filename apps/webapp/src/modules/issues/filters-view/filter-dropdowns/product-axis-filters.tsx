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

import { DropdownItem } from 'modules/issues/components/issue-metadata/dropdown-item';
import { withoutArchived } from 'modules/product-axis/archive';
import { AxisIcon } from 'modules/product-axis/axis-icon';

import type { CapabilityType, ModuleType, ProductType } from 'common/types';

import { useScope } from 'hooks';

import { FilterTypeEnum } from 'store/application';
import { useContextStore } from 'store/global-context-provider';

/**
 * The filters of the product axis: product, module and capability.
 *
 * A team and a module are different axes on purpose, so none of these lists is
 * narrowed to the team of the page. A person on one team often wants the issues
 * of a module that another team also writes in.
 *
 * The three read the same shape, so one list component serves all of them.
 */

interface AxisOption {
  id: string;
  name: string;
  icon?: string;
  color?: string;
}

type AxisKind = 'product' | 'module' | 'capability';

const PLACEHOLDER: Record<AxisKind, string> = {
  product: 'Set product...',
  module: 'Set module...',
  capability: 'Set capability...',
};

const PLURAL: Record<AxisKind, string> = {
  product: 'Products',
  module: 'Modules',
  capability: 'Capabilities',
};

function AxisList({
  kind,
  options,
  value,
  onChange,
}: {
  kind: AxisKind;
  options: AxisOption[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  useScope('command');

  const toggle = (id: string) =>
    onChange(
      value.includes(id)
        ? value.filter((entry) => entry !== id)
        : [...value, id],
    );

  return (
    <CommandGroup>
      {options.map((option, index) => (
        <DropdownItem
          key={option.id}
          id={option.id}
          value={option.name}
          index={index}
          onSelect={() => toggle(option.id)}
        >
          <div className="flex items-center gap-2">
            <Checkbox
              checked={value.includes(option.id)}
              onCheckedChange={() => toggle(option.id)}
            />
            <AxisIcon
              kind={kind}
              name={option.name}
              icon={option.icon}
              color={option.color}
              size="md"
            />
            <span className="grow truncate">{option.name}</span>
          </div>
        </DropdownItem>
      ))}

      {options.length === 0 && (
        <div className="px-3 py-2 text-muted-foreground">
          This workspace has no {kind} yet.
        </div>
      )}
    </CommandGroup>
  );
}

/**
 * The list that opens when somebody picks one of these from the filter menu.
 */
function AxisFilter({
  kind,
  options,
  onChange,
}: {
  kind: AxisKind;
  options: AxisOption[];
  onChange: (value: string[], filterType: FilterTypeEnum) => void;
}) {
  const { applicationStore } = useContextStore();
  const current = applicationStore.filters[kind]
    ? applicationStore.filters[kind].value
    : [];

  return (
    <AxisList
      kind={kind}
      options={options}
      value={current}
      // A module list on an issue holds several values, so it takes the
      // INCLUDES path. A capability and a product each compare one value.
      onChange={(ids) =>
        onChange(
          ids,
          kind === 'module' ? FilterTypeEnum.INCLUDES : FilterTypeEnum.IS,
        )
      }
    />
  );
}

/**
 * The chip that shows an applied filter, and reopens the same list.
 */
function AxisChip({
  kind,
  options,
  value = [],
  onChange,
}: {
  kind: AxisKind;
  options: AxisOption[];
  value?: string[];
  onChange?: (ids: string[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const first = options.find((option) => option.id === value[0]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          size="sm"
          aria-expanded={open}
          className={cn(
            'flex gap-1 items-center justify-between shadow-none !bg-transparent hover:bg-transparent p-0 border-0 focus-visible:ring-1 focus-visible:border-primary',
          )}
        >
          {value.length > 1 ? (
            <>
              {value.length} {PLURAL[kind]}
            </>
          ) : (
            <div className="flex min-w-[0px] shrink items-center gap-1">
              <AxisIcon
                kind={kind}
                name={first?.name ?? ''}
                icon={first?.icon}
                color={first?.color}
                size="md"
              />
              <div className="truncate">{first?.name ?? 'Unknown'}</div>
            </div>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={PLACEHOLDER[kind]} autoFocus />
          <AxisList
            kind={kind}
            options={options}
            value={value}
            onChange={onChange}
          />
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function useProductOptions(): AxisOption[] {
  const { productsStore } = useContextStore();

  return withoutArchived<ProductType>(productsStore.getProducts).map(
    (product) => ({
      id: product.id,
      name: product.name,
      icon: product.icon,
      color: product.color,
    }),
  );
}

function useModuleOptions(): AxisOption[] {
  const { modulesStore } = useContextStore();

  return withoutArchived<ModuleType>(modulesStore.getModules).map((module) => ({
    id: module.id,
    name: module.name,
    icon: module.icon,
    color: module.color,
  }));
}

function useCapabilityOptions(): AxisOption[] {
  const { capabilitiesStore } = useContextStore();

  return withoutArchived<CapabilityType>(capabilitiesStore.getCapabilities).map(
    (capability) => ({
      id: capability.id,
      name: capability.name,
    }),
  );
}

interface FilterProps {
  onChange: (value: string[], filterType: FilterTypeEnum) => void;
  onClose: () => void;
}

export const IssueProductFilter = observer(({ onChange }: FilterProps) => (
  <AxisFilter
    kind="product"
    options={useProductOptions()}
    onChange={onChange}
  />
));

export const IssueModuleFilter = observer(({ onChange }: FilterProps) => (
  <AxisFilter kind="module" options={useModuleOptions()} onChange={onChange} />
));

export const IssueCapabilityFilter = observer(({ onChange }: FilterProps) => (
  <AxisFilter
    kind="capability"
    options={useCapabilityOptions()}
    onChange={onChange}
  />
));

interface ChipProps {
  value?: string[];
  onChange?: (ids: string[]) => void;
}

export const IssueProductDropdown = observer((props: ChipProps) => (
  <AxisChip kind="product" options={useProductOptions()} {...props} />
));

export const IssueModuleDropdown = observer((props: ChipProps) => (
  <AxisChip kind="module" options={useModuleOptions()} {...props} />
));

export const IssueCapabilityDropdown = observer((props: ChipProps) => (
  <AxisChip kind="capability" options={useCapabilityOptions()} {...props} />
));
