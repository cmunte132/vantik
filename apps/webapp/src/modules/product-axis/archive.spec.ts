import { describe, expect, it } from 'vitest';

import {
  ARCHIVED_STATUS,
  isArchived,
  statusAfterArchive,
  withoutArchived,
} from './archive';

/**
 * Archive is a status, because a product, a module and a capability all carry
 * one already. The rule below is what every list that offers a choice reads:
 * the sidebar, the grouping views, the filters, and the pickers on an issue.
 *
 * The two ways to get this wrong are opposite and both bad. A list that keeps
 * an archived row offers work that stopped. A list that drops one somewhere it
 * should not makes the row unreachable, and a person cannot restore it.
 */

const product = (status?: string | null) => ({ id: 'product-1', status });

describe('isArchived', () => {
  it('finds an archived row', () => {
    expect(isArchived(product(ARCHIVED_STATUS))).toBe(true);
  });

  it('leaves every other status alone', () => {
    expect(isArchived(product('active'))).toBe(false);
    expect(isArchived(product('planned'))).toBe(false);
    expect(isArchived(product('live'))).toBe(false);
    expect(isArchived(product('deprecated'))).toBe(false);
  });

  /**
   * `status` is nullable in the schema, and a row made before this field had a
   * default carries null. A null status is not an archive.
   */
  it('reads a row that has no status', () => {
    expect(isArchived(product(null))).toBe(false);
    expect(isArchived(product(undefined))).toBe(false);
    expect(isArchived(null)).toBe(false);
    expect(isArchived(undefined)).toBe(false);
  });

  it('does not read a status that merely contains the word', () => {
    expect(isArchived(product('unarchived'))).toBe(false);
    expect(isArchived(product('Archived'))).toBe(false);
  });
});

describe('withoutArchived', () => {
  it('removes the archived rows and keeps the order of the rest', () => {
    const rows = [
      { id: 'a', status: 'active' },
      { id: 'b', status: ARCHIVED_STATUS },
      { id: 'c', status: 'planned' },
    ];

    expect(withoutArchived(rows).map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('keeps a row that has no status', () => {
    expect(withoutArchived([{ id: 'a', status: null }])).toHaveLength(1);
  });

  it('returns an empty list when everything is archived', () => {
    expect(withoutArchived([{ id: 'a', status: ARCHIVED_STATUS }])).toEqual([]);
  });

  it('returns an empty list for an empty list', () => {
    expect(withoutArchived([])).toEqual([]);
  });

  it('does not change the list it was given', () => {
    const rows = [{ id: 'a', status: ARCHIVED_STATUS }];

    withoutArchived(rows);

    expect(rows).toHaveLength(1);
  });
});

describe('statusAfterArchive', () => {
  it('archives all three kinds the same way', () => {
    expect(statusAfterArchive('product', true)).toBe(ARCHIVED_STATUS);
    expect(statusAfterArchive('module', true)).toBe(ARCHIVED_STATUS);
    expect(statusAfterArchive('capability', true)).toBe(ARCHIVED_STATUS);
  });

  it('restores a product and a module to active', () => {
    expect(statusAfterArchive('product', false)).toBe('active');
    expect(statusAfterArchive('module', false)).toBe('active');
  });

  /**
   * A capability that nobody has built is planned, and a restored one names no
   * work in progress either. `active` would claim more than is known.
   */
  it('restores a capability to planned', () => {
    expect(statusAfterArchive('capability', false)).toBe('planned');
  });

  it('never returns the archived status on a restore', () => {
    for (const kind of ['product', 'module', 'capability'] as const) {
      expect(statusAfterArchive(kind, false)).not.toBe(ARCHIVED_STATUS);
    }
  });
});
