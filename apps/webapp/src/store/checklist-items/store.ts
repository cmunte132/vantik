import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import type { ChecklistItemType } from 'common/types';

import { vantikDatabase } from 'store/database';

import { ChecklistItemArray } from './models';

export const ChecklistItemsStore: IAnyStateTreeNode = types
  .model({
    checklistItems: types.map(ChecklistItemArray),
  })
  .actions((self) => {
    const update = (checklistItem: ChecklistItemType, id: string) => {
      const issueId = checklistItem.issueId;
      if (!self.checklistItems.has(issueId)) {
        self.checklistItems.set(issueId, ChecklistItemArray.create([]));
      }

      const itemsArray = self.checklistItems.get(issueId);
      const indexToUpdate = itemsArray.findIndex((obj) => obj.id === id);

      if (indexToUpdate !== -1) {
        itemsArray[indexToUpdate] = {
          ...itemsArray[indexToUpdate],
          ...checklistItem,
        };
      } else {
        itemsArray.push(checklistItem);
      }
    };

    const deleteById = (id: string) => {
      for (const [issueId, itemsArray] of self.checklistItems.entries()) {
        const indexToDelete = itemsArray.findIndex((obj) => obj.id === id);

        if (indexToDelete !== -1) {
          itemsArray.splice(indexToDelete, 1);
          if (itemsArray.length === 0) {
            self.checklistItems.delete(issueId);
          }
          break;
        }
      }
    };

    const load = flow(function* (issueId: string) {
      const checklistItems = issueId
        ? yield vantikDatabase.checklistItems
            .where({
              issueId,
            })
            .toArray()
        : [];

      if (checklistItems.length > 0) {
        self.checklistItems.set(
          issueId,
          ChecklistItemArray.create(checklistItems),
        );
      }
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    getChecklistItems(issueId: string): ChecklistItemType[] {
      const items: ChecklistItemType[] = self.checklistItems.has(issueId)
        ? self.checklistItems.get(issueId)
        : [];

      // The server orders by sortOrder then createdAt; sync records arrive in
      // whatever order they replicate, so re-apply it here.
      return [...items].sort((a: ChecklistItemType, b: ChecklistItemType) => {
        const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;

        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }

        return a.createdAt.localeCompare(b.createdAt);
      });
    },
  }));

export type ChecklistItemsStoreType = Instance<typeof ChecklistItemsStore>;
