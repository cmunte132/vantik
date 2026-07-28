import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import type { ProductType } from 'common/types';

import { vantikDatabase } from 'store/database';

import { Product } from './models';

export const ProductsStore: IAnyStateTreeNode = types
  .model({
    products: types.array(Product),
    workspaceId: types.union(types.string, types.undefined),
  })
  .actions((self) => {
    const update = (product: ProductType, id: string) => {
      const indexToUpdate = self.products.findIndex((obj) => obj.id === id);

      if (indexToUpdate !== -1) {
        self.products[indexToUpdate] = {
          ...self.products[indexToUpdate],
          ...product,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      } else {
        self.products.push(product);
      }
    };

    const deleteById = (id: string) => {
      const indexToDelete = self.products.findIndex((obj) => obj.id === id);

      if (indexToDelete !== -1) {
        self.products.splice(indexToDelete, 1);
      }
    };

    const load = flow(function* () {
      const products = yield vantikDatabase.products.toArray();

      self.products = products;
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    getProductWithId(id: string) {
      return self.products.find((product) => product.id === id);
    },

    getProductWithKey(key: string) {
      return self.products.find((product) => product.key === key);
    },

    get getProducts() {
      return self.products;
    },
  }));

export type ProductsStoreType = Instance<typeof ProductsStore>;
