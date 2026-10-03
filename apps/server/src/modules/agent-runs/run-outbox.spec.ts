import { newOutboxState, OUTBOX_LIMITS, readOutbox } from './run-outbox';

const PACK = {
  definitionOfDone: [
    { id: 'c1', body: 'Keeps the last row', completed: false },
  ],
};
const lines = (...items: unknown[]) =>
  items.map((item) => `${JSON.stringify(item)}\n`).join('');

describe('reading an agent’s outbox', () => {
  it('reads each line once, across passes, and leaves a half-written line for later', () => {
    const state = newOutboxState();
    const first = lines({ v: 1, type: 'note', body: 'one' });

    expect(readOutbox(first, PACK, state).notes).toEqual([{ body: 'one' }]);

    const grown = `${first}${lines({ v: 1, type: 'note', body: 'two' })}{"v":1,"type":"no`;
    expect(readOutbox(grown, PACK, state).notes).toEqual([{ body: 'two' }]);
    expect(state.lines).toBe(2);
  });

  it('holds criteria to this issue’s and to evidence', () => {
    const state = newOutboxState();
    const batch = readOutbox(
      lines(
        { v: 1, type: 'criterion', id: 'c1', evidence: 'the spec passes' },
        { v: 1, type: 'criterion', id: 'other-issue', evidence: 'x' },
        { v: 1, type: 'criterion', id: 'c1', evidence: '  ' },
      ),
      PACK,
      state,
    );

    expect(batch.criteria).toEqual([{ id: 'c1', evidence: 'the spec passes' }]);
    expect(batch.rejected.map((r) => r.reason)).toEqual([
      'not a criterion of this issue',
      'no evidence',
    ]);
    expect([...state.criteria.keys()]).toEqual(['c1']);
  });

  it('caps notes and facts per run, and refuses what it cannot read', () => {
    const state = newOutboxState();
    const notes = Array.from({ length: OUTBOX_LIMITS.notes + 2 }, (_, i) => ({
      v: 1,
      type: 'note',
      body: `note ${i}`,
    }));
    const batch = readOutbox(
      `${lines(
        ...notes,
        { v: 2, type: 'note', body: 'x' },
        { v: 1, type: 'shell', cmd: 'rm' },
      )}not json\n`,
      PACK,
      state,
    );

    expect(batch.notes).toHaveLength(OUTBOX_LIMITS.notes);
    expect(batch.rejected.map((r) => r.reason)).toEqual([
      'too many notes',
      'too many notes',
      'unknown record',
      'unknown record',
      'not JSON',
    ]);
  });

  it('keeps a fact’s citations to paths in the repository', () => {
    const batch = readOutbox(
      lines({
        v: 1,
        type: 'remember',
        content: 'Rows are paged by 500.',
        kind: 'GOTCHA',
        citations: [
          { path: 'src/importer.ts', lines: '80-90' },
          { path: '/etc/passwd' },
          { path: 'src/../../outside' },
          { path: 'src/a.ts', lines: 'all of them' },
        ],
      }),
      PACK,
      newOutboxState(),
    );

    expect(batch.facts).toEqual([
      {
        content: 'Rows are paged by 500.',
        kind: 'GOTCHA',
        citations: [
          { path: 'src/importer.ts', lines: '80-90' },
          { path: 'src/a.ts' },
        ],
      },
    ]);
  });

  it('refuses a fact too long to be one', () => {
    const batch = readOutbox(
      lines({
        v: 1,
        type: 'remember',
        content: 'x'.repeat(OUTBOX_LIMITS.factLength + 1),
      }),
      PACK,
      newOutboxState(),
    );

    expect(batch.facts).toEqual([]);
    expect(batch.rejected[0].reason).toBe('empty or oversized fact');
  });
});
