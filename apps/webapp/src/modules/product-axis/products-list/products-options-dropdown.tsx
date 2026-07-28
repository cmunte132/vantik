import { Button } from '@vantikhq/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import { DeleteLine, Inbox, MoreLine } from '@vantikhq/ui/icons';
import * as React from 'react';

import type { ProductType } from 'common/types';

import {
  useDeleteProductMutation,
  useUpdateProductMutation,
} from 'services/product-axis';

import { isArchived, statusAfterArchive } from '../archive';

/**
 * What can be done to a product without opening it.
 *
 * The same two things its own page offers, in the same order: archive, which is
 * the one a person wants far more often, and then delete. Renaming is not here,
 * because a name is edited where it is read.
 */
export function ProductOptionsDropdown({
  product,
  onError,
}: {
  product: ProductType;
  onError: (message: string) => void;
}) {
  const { mutate: updateProduct } = useUpdateProductMutation({});
  const { mutate: deleteProduct } = useDeleteProductMutation({});

  const archived = isArchived(product);

  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="link"
            size="sm"
            aria-label={`Options for ${product.name}`}
            // The row navigates, and this control sits inside it.
            onClick={(event) => event.stopPropagation()}
          >
            <MoreLine size={16} />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={(event) => {
                event.stopPropagation();
                updateProduct({
                  productId: product.id,
                  status: statusAfterArchive('product', !archived),
                });
              }}
            >
              <div className="flex items-center gap-1">
                <Inbox size={16} /> {archived ? 'Restore' : 'Archive'}
              </div>
            </DropdownMenuItem>

            <DropdownMenuItem
              onClick={(event) => {
                event.stopPropagation();
                deleteProduct(
                  { productId: product.id },
                  {
                    // A product that still owns modules cannot go. The server
                    // names them, and that sentence is the remedy.
                    onError: (response: { errors?: { message?: string } }) =>
                      onError(
                        response?.errors?.message ??
                          'That product could not be deleted.',
                      ),
                  },
                );
              }}
            >
              <div className="flex items-center gap-1">
                <DeleteLine size={16} /> Delete
              </div>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
