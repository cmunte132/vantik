import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import type { CapabilityType } from 'common/types';

import { vantikDatabase } from 'store/database';

import { Capability } from './models';

export const CapabilitiesStore: IAnyStateTreeNode = types
  .model({
    capabilities: types.array(Capability),
    workspaceId: types.union(types.string, types.undefined),
  })
  .actions((self) => {
    const update = (capability: CapabilityType, id: string) => {
      const indexToUpdate = self.capabilities.findIndex((obj) => obj.id === id);

      if (indexToUpdate !== -1) {
        self.capabilities[indexToUpdate] = {
          ...self.capabilities[indexToUpdate],
          ...capability,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      } else {
        self.capabilities.push(capability);
      }
    };

    const deleteById = (id: string) => {
      const indexToDelete = self.capabilities.findIndex((obj) => obj.id === id);

      if (indexToDelete !== -1) {
        self.capabilities.splice(indexToDelete, 1);
      }
    };

    const load = flow(function* () {
      const capabilities = yield vantikDatabase.capabilities.toArray();

      self.capabilities = capabilities;
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    getCapabilityWithId(id: string) {
      return self.capabilities.find((capability) => capability.id === id);
    },

    /**
     * The capabilities that live in any of these modules.
     *
     * This is how a product gets a list of capabilities. A capability holds no
     * product field, so the caller passes the modules that a product owns and
     * links, and this reads the graph the other way round.
     */
    getCapabilitiesForModules(moduleIds: string[]) {
      const wanted = new Set(moduleIds);

      return self.capabilities.filter((capability) =>
        capability.moduleIds.some((moduleId) => wanted.has(moduleId)),
      );
    },

    /** Capabilities that no module holds. Nobody has built these yet. */
    get getUnbuiltCapabilities() {
      return self.capabilities.filter(
        (capability) => capability.moduleIds.length === 0,
      );
    },

    get getCapabilities() {
      return self.capabilities;
    },
  }));

export type CapabilitiesStoreType = Instance<typeof CapabilitiesStore>;
