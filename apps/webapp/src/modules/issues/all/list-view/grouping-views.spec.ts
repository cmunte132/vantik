import { describe, expect, it } from 'vitest';

import { GroupingEnum } from 'store/application';

import {
  DEFAULT_VIEW_NAME,
  VIEW_NAME_FOR_GROUPING,
  viewNameForGrouping,
} from './grouping-views';

/**
 * Every grouping a person can choose has to reach a view of its own.
 *
 * `GroupingEnum` held `module` and `capability` while the dispatch in
 * `list-view.tsx` was a chain of ifs that ended at the category view. Choosing
 * either one therefore grouped the list by status and said nothing about it.
 *
 * The compiler now refuses a grouping with no view, because the mapping is a
 * `Record` with a closed key. These tests hold the other half: a grouping that
 * is present but points at the wrong view.
 */

describe('viewNameForGrouping', () => {
  it('gives the second axis a view of its own', () => {
    expect(viewNameForGrouping(GroupingEnum.module)).toBe('module');
    expect(viewNameForGrouping(GroupingEnum.capability)).toBe('capability');
  });

  it('sends only status to the status view', () => {
    const byStatus = Object.values(GroupingEnum).filter(
      (grouping) => viewNameForGrouping(grouping) === 'status',
    );

    expect(byStatus).toEqual([GroupingEnum.status]);
  });

  it('gives a distinct view to every grouping', () => {
    const names = Object.values(GroupingEnum).map(viewNameForGrouping);

    expect(new Set(names).size).toBe(Object.values(GroupingEnum).length);
  });

  it('names a view for every grouping that exists', () => {
    for (const grouping of Object.values(GroupingEnum)) {
      expect(VIEW_NAME_FOR_GROUPING[grouping]).toBeTruthy();
    }
  });

  /**
   * A display setting outlives the code that wrote it, so a grouping this
   * version does not know still arrives from the store.
   */
  it('falls back for a grouping that this version does not know', () => {
    expect(viewNameForGrouping('something-a-later-version-added')).toBe(
      DEFAULT_VIEW_NAME,
    );
    expect(viewNameForGrouping('')).toBe(DEFAULT_VIEW_NAME);
  });
});
