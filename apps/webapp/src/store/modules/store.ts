import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import type { ModuleType } from 'common/types';

import { vantikDatabase } from 'store/database';

import { ProductModule } from './models';

export const ModulesStore: IAnyStateTreeNode = types
  .model({
    modules: types.array(ProductModule),
    workspaceId: types.union(types.string, types.undefined),
  })
  .actions((self) => {
    const update = (module: ModuleType, id: string) => {
      const indexToUpdate = self.modules.findIndex((obj) => obj.id === id);

      if (indexToUpdate !== -1) {
        self.modules[indexToUpdate] = {
          ...self.modules[indexToUpdate],
          ...module,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      } else {
        self.modules.push(module);
      }
    };

    const deleteById = (id: string) => {
      const indexToDelete = self.modules.findIndex((obj) => obj.id === id);

      if (indexToDelete !== -1) {
        self.modules.splice(indexToDelete, 1);
      }
    };

    const load = flow(function* () {
      const modules = yield vantikDatabase.modules.toArray();

      self.modules = modules;
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    getModuleWithId(id: string) {
      return self.modules.find((module) => module.id === id);
    },

    /** The modules a product owns. These are the ones it is responsible for. */
    getModulesOwnedByProduct(productId: string) {
      return self.modules.filter(
        (module) => module.ownerProductId === productId,
      );
    },

    /**
     * The modules a product borrows. A link carries no authority, so these
     * render dimmed: the product uses the code and does not own it.
     */
    getModulesLinkedToProduct(productId: string) {
      return self.modules.filter(
        (module) =>
          module.ownerProductId !== productId &&
          module.linkedProductIds.includes(productId),
      );
    },

    /** The modules a team owns. A team owns the modules of internal tools. */
    getModulesOwnedByTeam(teamId: string) {
      return self.modules.filter((module) => module.ownerTeamId === teamId);
    },

    getModulesLinkedToTeam(teamId: string) {
      return self.modules.filter(
        (module) =>
          module.ownerTeamId !== teamId && module.linkedTeamIds.includes(teamId),
      );
    },

    get getModules() {
      return self.modules;
    },
  }));

export type ModulesStoreType = Instance<typeof ModulesStore>;
