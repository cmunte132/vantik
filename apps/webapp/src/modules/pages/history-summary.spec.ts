import { describe, expect, it } from 'vitest';

import { summarize } from './history-summary';

/** A page's history, as a person reads it. */
describe('a change to a page, in words', () => {
  it('[KG-7.4] says a consolidation wrote notes in, and that undoing it put them back', () => {
    expect(
      summarize({
        body: true,
        consolidated: { to: 3 },
        proposal: { to: 'proposal-1' },
      }),
    ).toBe('Wrote 3 notes into the page');
    expect(
      summarize({
        body: true,
        revertedTo: { to: 'history-1' },
        unconsolidated: { to: 1 },
      }),
    ).toBe('Restored an earlier version, and put 1 note back in use');
    expect(summarize({ body: true, revertedTo: { to: 'history-2' } })).toBe(
      'Restored an earlier version',
    );
  });

  it('[KG-7.5] says a generated page was refreshed, and how much', () => {
    expect(
      summarize({ body: true, refreshed: { operations: 2, dropped: [] } }),
    ).toBe('Refreshed from its evidence: 2 edits');
    expect(summarize({ refreshed: { operations: 0, dropped: [] } })).toBe(
      'Refreshed from its evidence: nothing to change',
    );
  });

  it('[KG-7.1] says a generated page was taken over by hand, or asked a new question', () => {
    expect(
      summarize({
        kind: { from: 'GENERATED', to: 'AUTHORED' },
        body: true,
      }),
    ).toBe('Taken over by hand · Edited the body');
    expect(
      summarize({
        question: { from: 'How do we deploy?', to: 'How do we roll back?' },
      }),
    ).toBe('Asked “How do we roll back?”');
  });

  it('says what else changed, as before', () => {
    expect(summarize({ created: true })).toBe('Created the page');
    expect(
      summarize({
        title: { from: 'Old', to: 'New' },
        entryPolicy: { to: 'LOCKED' },
      }),
    ).toBe('Renamed “Old” to “New” · Set who may add facts to locked');
    expect(summarize({})).toBe('Changed the page');
  });
});
