import { describe, expect, it } from 'vitest';

import { PageEntryStatus } from 'common/types';

import { entryActions } from './entry-actions';

const labels = (status: PageEntryStatus, verifiedAt: string | null = null) =>
  entryActions({ status, verifiedAt }).map((action) => action.label);

describe('what a fact’s menu offers', () => {
  it('[KG-7.4] offers to take a fact written into the page out of use, and not to put it in use again', () => {
    expect(labels(PageEntryStatus.CONSOLIDATED)).toEqual([
      'Confirm',
      'Stop using it',
      'Mark as wrong',
    ]);
    expect(
      entryActions({
        status: PageEntryStatus.CONSOLIDATED,
        verifiedAt: null,
      }).map((action) => action.change),
    ).toEqual([
      { verified: true },
      { status: PageEntryStatus.ARCHIVED },
      { status: PageEntryStatus.DISPUTED },
    ]);
  });

  it('offers what it did before for the other facts', () => {
    expect(labels(PageEntryStatus.STANDING, '2026-09-28')).toEqual([
      'Stop using it',
      'Mark as wrong',
    ]);
    expect(labels(PageEntryStatus.DISPUTED)).toEqual([
      'Confirm',
      'Use it',
      'Stop using it',
    ]);
    expect(labels(PageEntryStatus.ARCHIVED)).toEqual([
      'Confirm',
      'Use it',
      'Mark as wrong',
    ]);
  });
});
