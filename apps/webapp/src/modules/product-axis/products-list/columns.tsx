'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Badge } from '@vantikhq/ui/components/badge';
import * as React from 'react';

import type { ModuleType, ProductType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

import { AxisIcon } from '../axis-icon';
import { ProductOptionsDropdown } from './products-options-dropdown';

/** Renders a date the way the teams list renders one. */
function formatDate(dateString: string) {
  const date = new Date(dateString);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');

  return `${day}-${month}-${date.getFullYear()}`;
}

/**
 * The columns of the products list.
 *
 * They answer the same questions the team columns answer, in the same order:
 * what it is called, what it is called in an address, what state it is in, and
 * when it started. A product's third column is its status rather than a
 * membership, because a person does not join a product — a product ships.
 */
export const useProductColumns = (
  onError: (message: string) => void,
): Array<ColumnDef<ProductType>> => {
  const { modulesStore } = useContextStore();

  return [
    {
      accessorKey: 'title',
      header: () => <span className="px-4">Title</span>,
      cell: ({ row }) => (
        <div className="pl-4 py-2 flex items-center gap-2">
          <AxisIcon
            kind="product"
            name={row.original.name}
            icon={row.original.icon}
            color={row.original.color}
          />
          {row.original.name}
        </div>
      ),
    },
    {
      accessorKey: 'Product Identifier',
      header: () => (
        <span className="px-4 whitespace-nowrap">Product Identifier</span>
      ),
      cell: ({ row }) => (
        <div className="pl-4 py-2 flex items-center gap-1 text-muted-foreground">
          {row.original.key}
        </div>
      ),
    },
    {
      accessorKey: 'Status',
      header: () => <span className="px-4 whitespace-nowrap">Status</span>,
      cell: ({ row }) => (
        <div className="pl-4 py-2 flex items-center gap-1">
          <Badge variant="secondary">{row.original.status ?? 'active'}</Badge>
        </div>
      ),
    },
    {
      accessorKey: 'Modules',
      header: () => <span className="px-4 whitespace-nowrap">Modules</span>,
      cell: ({ row }) => {
        const owned: ModuleType[] = modulesStore.getModulesOwnedByProduct(
          row.original.id,
        );

        return (
          <div className="pl-4 py-2 flex items-center gap-1 text-muted-foreground">
            {owned.length} module{owned.length === 1 ? '' : 's'}
          </div>
        );
      },
    },
    {
      accessorKey: 'Created At',
      header: () => <span className="px-4 whitespace-nowrap">Created At</span>,
      cell: ({ row }) => (
        <div className="pl-4 py-2 flex items-center gap-1 text-muted-foreground">
          {formatDate(row.original.createdAt)}
        </div>
      ),
    },
    {
      accessorKey: 'options',
      header: () => <span className="px-4 whitespace-nowrap"></span>,
      cell: ({ row }) => (
        <div className="pl-4 py-2 flex items-center justify-end gap-1">
          <ProductOptionsDropdown product={row.original} onError={onError} />
        </div>
      ),
    },
  ];
};
