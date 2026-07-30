import { describe, expect, it } from 'vitest';

import { groupRunsByIssue, sentenceCase, shortModel } from './group-runs';

/**
 * Grouping is the whole redesign, and every fault it can have is an ordering
 * fault — which is the kind that looks fine on one screenshot and wrong on the
 * next. So the order is pinned here rather than judged by eye.
 */

const label = (issueId: string) => ({
  key: issueId.toUpperCase(),
  title: `Title for ${issueId}`,
});

const run = (id: string, issueId: string, createdAt: string) => ({
  id,
  issueId,
  createdAt,
});

describe('groupRunsByIssue', () => {
  it('collects an issue’s runs into one group', () => {
    const groups = groupRunsByIssue(
      [
        run('c', 'eng-83', '2026-07-28T12:00:00Z'),
        run('b', 'eng-82', '2026-07-28T11:00:00Z'),
        run('a', 'eng-83', '2026-07-28T10:00:00Z'),
      ],
      label,
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.issueId)).toEqual(['eng-83', 'eng-82']);
    expect(groups[0].runs.map((entry) => entry.run.id)).toEqual(['c', 'a']);
  });

  it('numbers attempts from the first run, and shows the newest first', () => {
    // The two orders are opposite on purpose: #1 has to be the oldest, and the
    // row at the top has to be the newest. Numbering in display order would
    // label the newest run #1, which reads backwards.
    const groups = groupRunsByIssue(
      [
        run('third', 'eng-83', '2026-07-28T12:00:00Z'),
        run('first', 'eng-83', '2026-07-28T10:00:00Z'),
        run('second', 'eng-83', '2026-07-28T11:00:00Z'),
      ],
      label,
    );

    expect(groups[0].runs).toEqual([
      { run: expect.objectContaining({ id: 'third' }), ordinal: 3 },
      { run: expect.objectContaining({ id: 'second' }), ordinal: 2 },
      { run: expect.objectContaining({ id: 'first' }), ordinal: 1 },
    ]);
  });

  it('sorts groups by their most recent run, not by their first', () => {
    // An issue whose work restarted today belongs at the top even if its first
    // attempt is the oldest run in the workspace.
    const groups = groupRunsByIssue(
      [
        run('old-issue', 'eng-60', '2026-07-27T10:00:00Z'),
        run('ancient', 'eng-83', '2026-07-20T10:00:00Z'),
        run('newest', 'eng-83', '2026-07-29T10:00:00Z'),
      ],
      label,
    );

    expect(groups.map((group) => group.issueId)).toEqual(['eng-83', 'eng-60']);
    expect(groups[0].latestAt).toBe('2026-07-29T10:00:00Z');
  });

  it('keeps a run whose issue is gone, rather than dropping the row', () => {
    const groups = groupRunsByIssue(
      [run('orphan', 'deleted', '2026-07-28T10:00:00Z')],
      () => ({ key: null, title: 'Deleted issue' }),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].issue.title).toBe('Deleted issue');
  });
});

describe('shortModel', () => {
  it('drops the provider, which is the same on every row a key produced', () => {
    expect(shortModel('google/gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(shortModel('~anthropic/claude-fable-latest')).toBe(
      'claude-fable-latest',
    );
  });

  it('leaves an id that carries no provider alone', () => {
    expect(shortModel('gpt-5')).toBe('gpt-5');
  });
});

describe('sentenceCase', () => {
  it('reads a failure as a state rather than a log level', () => {
    expect(sentenceCase('out of budget')).toBe('Out of budget');
  });

  it('does not choke on an empty string', () => {
    expect(sentenceCase('')).toBe('');
  });
});
