import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import type { ProductType, TeamType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';
import { withoutArchived } from './archive';

export interface Owner {
  ownerTeamId: string | null;
  ownerProductId: string | null;
}

/**
 * The one owner of a module.
 *
 * A module belongs to a team or to a product, never to both and never to
 * neither. A check constraint in the database says so, and this control is what
 * stops a person from meeting that constraint as an error message. There is one
 * list, and picking any row clears the other field.
 */
export const OwnerSelect = observer(
  ({ value, onChange }: { value: Owner; onChange: (owner: Owner) => void }) => {
    const { productsStore, teamsStore } = useContextStore();

    // An archived product takes on nothing new, so it is not an owner to pick.
    const products: ProductType[] = withoutArchived<ProductType>(
      productsStore.getProducts,
    );
    const teams: TeamType[] = teamsStore.teams;

    const current = value.ownerProductId
      ? `product:${value.ownerProductId}`
      : value.ownerTeamId
        ? `team:${value.ownerTeamId}`
        : '';

    return (
      <Select
        value={current}
        onValueChange={(next: string) => {
          const [kind, id] = next.split(':');

          onChange(
            kind === 'product'
              ? { ownerProductId: id, ownerTeamId: null }
              : { ownerTeamId: id, ownerProductId: null },
          );
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Choose an owner" />
        </SelectTrigger>
        <SelectContent>
          {products.map((product) => (
            <SelectItem key={product.id} value={`product:${product.id}`}>
              {product.name} (product)
            </SelectItem>
          ))}
          {teams.map((team) => (
            <SelectItem key={team.id} value={`team:${team.id}`}>
              {team.name} (team)
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  },
);
