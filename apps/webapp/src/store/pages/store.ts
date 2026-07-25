import {
  type IAnyStateTreeNode,
  type Instance,
  types,
  flow,
} from 'mobx-state-tree';

import type { PageType } from 'common/types';

import { vantikDatabase } from 'store/database';

import { Page } from './models';

export const PagesStore: IAnyStateTreeNode = types
  .model({
    pages: types.array(Page),
  })
  .actions((self) => {
    const update = (page: PageType, id: string) => {
      const indexToUpdate = self.pages.findIndex((obj) => obj.id === id);

      if (indexToUpdate !== -1) {
        self.pages[indexToUpdate] = {
          ...self.pages[indexToUpdate],
          ...page,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      } else {
        self.pages.push(page);
      }
    };

    const deleteById = (id: string) => {
      const indexToDelete = self.pages.findIndex((obj) => obj.id === id);

      if (indexToDelete !== -1) {
        self.pages.splice(indexToDelete, 1);
      }
    };

    const load = flow(function* () {
      const pages = yield vantikDatabase.pages.toArray();

      self.pages = pages;
    });

    return { update, deleteById, load };
  })
  .views((self) => ({
    getPageWithId(id: string) {
      return self.pages.find((page) => page.id === id);
    },

    /**
     * A page's children, in the order the sidebar renders them.
     *
     * Sync records arrive in whatever order they replicate, so the server's
     * `sortOrder` then `createdAt` ordering has to be re-applied here or the
     * tree reshuffles itself every time anything changes.
     */
    getChildren(parentId: string | null) {
      return self.pages
        .filter((page: PageType) => (page.parentId ?? null) === parentId)
        .sort((a: PageType, b: PageType) => {
          const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;

          return aOrder !== bOrder
            ? aOrder - bOrder
            : a.createdAt.localeCompare(b.createdAt);
        });
    },

    /**
     * A page's ancestors, root first — the breadcrumb.
     *
     * `seen` bounds the walk: the server refuses to make a page its own
     * ancestor, but a cycle arriving over sync from a database edited by hand
     * would otherwise hang the render.
     */
    getAncestors(id: string): PageType[] {
      const ancestors: PageType[] = [];
      const seen = new Set<string>([id]);

      let current = self.pages.find((page) => page.id === id);

      while (current?.parentId && !seen.has(current.parentId)) {
        const parent = self.pages.find(
          (page: PageType) => page.id === current.parentId,
        );

        if (!parent) {
          break;
        }

        seen.add(parent.id);
        ancestors.unshift(parent);
        current = parent;
      }

      return ancestors;
    },

    get getPages() {
      return self.pages;
    },
  }));

export type PagesStoreType = Instance<typeof PagesStore>;
