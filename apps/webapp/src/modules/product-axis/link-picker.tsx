import { RiAddLine, RiCloseLine } from '@remixicon/react';
import { Badge } from '@vantikhq/ui/components/badge';
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
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { DropdownItem } from 'modules/issues/components/issue-metadata/dropdown-item';

import type { ModuleType, ProductType, TeamType } from 'common/types';

import { useScope } from 'hooks';

import { useUpdateModuleMutation } from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

import { withoutArchived } from './archive';

/**
 * The teams and products that use a module without owning it.
 *
 * The owner is excluded from what can be added: it is already responsible, and
 * listing it again as a link would say something weaker than the truth.
 */
export const LinkPicker = observer(({ module }: { module: ModuleType }) => {
  const { productsStore, teamsStore } = useContextStore();
  const { mutate: updateModule } = useUpdateModuleMutation({});

  const products: ProductType[] = productsStore.getProducts;
  const teams: TeamType[] = teamsStore.teams;

  const linkedProducts = module.linkedProductIds
    .map((id) => products.find((product) => product.id === id))
    .filter(Boolean) as ProductType[];
  const linkedTeams = module.linkedTeamIds
    .map((id) => teams.find((team) => team.id === id))
    .filter(Boolean) as TeamType[];

  // The linked lists above resolve every product, archived or not, because a
  // link that exists has to render. Only the list of what a person can add
  // leaves the archived ones out.
  const addable = [
    ...withoutArchived<ProductType>(products)
      .filter(
        (product) =>
          product.id !== module.ownerProductId &&
          !module.linkedProductIds.includes(product.id),
      )
      .map((product) => ({
        kind: 'product' as const,
        id: product.id,
        name: product.name,
      })),
    ...teams
      .filter(
        (team) =>
          team.id !== module.ownerTeamId &&
          !module.linkedTeamIds.includes(team.id),
      )
      .map((team) => ({ kind: 'team' as const, id: team.id, name: team.name })),
  ];

  const add = (kind: 'product' | 'team', id: string) =>
    updateModule(
      kind === 'product'
        ? {
            moduleId: module.id,
            linkedProductIds: [...module.linkedProductIds, id],
          }
        : { moduleId: module.id, linkedTeamIds: [...module.linkedTeamIds, id] },
    );

  const remove = (kind: 'product' | 'team', id: string) =>
    updateModule(
      kind === 'product'
        ? {
            moduleId: module.id,
            linkedProductIds: module.linkedProductIds.filter(
              (linked) => linked !== id,
            ),
          }
        : {
            moduleId: module.id,
            linkedTeamIds: module.linkedTeamIds.filter(
              (linked) => linked !== id,
            ),
          },
    );

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
      {linkedTeams.length === 0 && linkedProducts.length === 0 && (
        <span className="text-muted-foreground">
          Nothing links to this yet.
        </span>
      )}

      {linkedTeams.map((team) => (
        <Badge key={team.id} variant="secondary" className="gap-1">
          {team.name}
          <button
            type="button"
            aria-label={`Unlink ${team.name}`}
            onClick={() => remove('team', team.id)}
          >
            <RiCloseLine size={12} />
          </button>
        </Badge>
      ))}

      {linkedProducts.map((product) => (
        <Badge key={product.id} variant="secondary" className="gap-1">
          {product.name}
          <button
            type="button"
            aria-label={`Unlink ${product.name}`}
            onClick={() => remove('product', product.id)}
          >
            <RiCloseLine size={12} />
          </button>
        </Badge>
      ))}

      {addable.length > 0 && <AddLink options={addable} onAdd={add} />}
    </div>
  );
});

interface Addable {
  kind: 'product' | 'team';
  id: string;
  name: string;
}

function AddLink({
  options,
  onAdd,
}: {
  options: Addable[];
  onAdd: (kind: 'product' | 'team', id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1">
          <RiAddLine size={14} />
          Add link
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <AddLinkContent
          options={options}
          onSelect={(option) => {
            onAdd(option.kind, option.id);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function AddLinkContent({
  options,
  onSelect,
}: {
  options: Addable[];
  onSelect: (option: Addable) => void;
}) {
  useScope('command');

  return (
    <Command>
      <CommandInput placeholder="Link a team or product..." autoFocus />
      <CommandGroup>
        {options.map((option, index) => (
          <DropdownItem
            key={`${option.kind}-${option.id}`}
            id={option.id}
            value={option.name}
            index={index}
            onSelect={() => onSelect(option)}
          >
            <div className="flex gap-2 items-center">
              <span className="flex-1">{option.name}</span>
              <span className="text-muted-foreground">{option.kind}</span>
            </div>
          </DropdownItem>
        ))}
      </CommandGroup>
    </Command>
  );
}
