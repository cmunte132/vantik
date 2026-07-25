import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import { PageEntryStatus, type PageEntryType } from 'common/types';

import { vantikDatabase } from 'store/database';

import { PageEntryArray } from './models';

export const PageEntriesStore: IAnyStateTreeNode = types
  .model({
    /** Keyed by page, the way the rail reads them. */
    pageEntries: types.map(PageEntryArray),
  })
  .actions((self) => {
    const update = (entry: PageEntryType, id: string) => {
      const pageId = entry.pageId;
      if (!self.pageEntries.has(pageId)) {
        self.pageEntries.set(pageId, PageEntryArray.create([]));
      }

      const entries = self.pageEntries.get(pageId);
      const indexToUpdate = entries.findIndex((obj) => obj.id === id);

      if (indexToUpdate !== -1) {
        entries[indexToUpdate] = { ...entries[indexToUpdate], ...entry };
      } else {
        entries.push(entry);
      }
    };

    const deleteById = (id: string) => {
      for (const [pageId, entries] of self.pageEntries.entries()) {
        const indexToDelete = entries.findIndex((obj) => obj.id === id);

        if (indexToDelete !== -1) {
          entries.splice(indexToDelete, 1);
          if (entries.length === 0) {
            self.pageEntries.delete(pageId);
          }
          break;
        }
      }
    };

    const load = flow(function* (pageId: string) {
      const entries = pageId
        ? yield vantikDatabase.pageEntries.where({ pageId }).toArray()
        : [];

      if (entries.length > 0) {
        self.pageEntries.set(pageId, PageEntryArray.create(entries));
      }
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    getEntries(pageId: string): PageEntryType[] {
      const entries: PageEntryType[] = self.pageEntries.has(pageId)
        ? self.pageEntries.get(pageId)
        : [];

      // Newest first: the inbox is read top-down and the newest claim is the
      // one most likely to still be relevant.
      return [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    getByStatus(pageId: string, status: PageEntryStatus): PageEntryType[] {
      return this.getEntries(pageId).filter(
        (entry: PageEntryType) => entry.status === status,
      );
    },

    /**
     * Counts by source and scope for one status.
     *
     * The same facet-first idea the search API returns, computed locally for
     * the page currently open — a rail that lists entries one per row is usable
     * at five and abandoned at fifty, and fifty is the steady state for an
     * active page.
     */
    facets(pageId: string, status: PageEntryStatus) {
      const entries = this.getByStatus(pageId, status);

      const count = (
        key: (entry: PageEntryType) => string,
      ): Record<string, number> =>
        entries.reduce((counts: Record<string, number>, entry) => {
          const value = key(entry);
          counts[value] = (counts[value] ?? 0) + 1;
          return counts;
        }, {});

      return {
        total: entries.length,
        sourceUserId: count((entry) => entry.sourceUserId ?? ''),
        scope: count((entry) => entry.scope ?? ''),
      };
    },
  }));

export type PageEntriesStoreType = Instance<typeof PageEntriesStore>;
