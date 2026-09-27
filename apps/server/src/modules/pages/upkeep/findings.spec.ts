/**
 * How review findings are compared and grouped: by the words they share,
 * deterministically, with no model.
 */
import {
  distinctRuns,
  findingWords,
  groupFindings,
  likeness,
  lineOf,
  moduleOfPath,
  representative,
} from './findings';

const finding = (id: string, run: string, message: string, at: number) => ({
  id,
  agentRunId: run,
  words: findingWords(message),
  createdAt: new Date(at),
});

describe('comparing review findings', () => {
  it('[KG-6.3] reads a finding as its uncommon words, once each', () => {
    expect(
      findingWords(
        'The cache key is built by hand, by hand, in 3 places from line 120!',
      ),
    ).toEqual(['cache', 'key', 'built', 'hand', 'places', 'line']);
    expect(findingWords('')).toEqual([]);
  });

  it('[KG-6.3] measures two findings by the share of all their words they have in common', () => {
    expect(likeness(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(likeness(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
    expect(likeness(['a', 'b', 'c', 'd'], ['a', 'b'])).toBe(0.5);
    expect(likeness(['a'], ['b'])).toBe(0);
    expect(likeness([], [])).toBe(0);
  });

  it('[KG-6.3] groups findings that share at least half their words, against each group’s first', () => {
    const groups = groupFindings([
      finding('3', 'run-3', 'retry fetch timeout', 3),
      finding('1', 'run-1', 'retry fetch backoff jitter', 1),
      // Half of all its words with the first: the same finding.
      finding('2', 'run-2', 'retry fetch', 2),
      finding('4', 'run-4', 'fetch timeout', 4),
      // Half like the second and the fourth, but neither is its group's
      // first: a group does not drift one step at a time.
      finding('5', 'run-5', 'fetch', 5),
    ]);

    expect(groups.map((group) => group.map((f) => f.id))).toEqual([
      ['1', '2'],
      ['3', '4'],
      ['5'],
    ]);
    expect(distinctRuns(groups[0])).toBe(2);
    expect(
      distinctRuns([
        finding('a', 'run-1', 'x', 1),
        finding('b', 'run-1', 'x', 2),
      ]),
    ).toBe(1);
  });

  it('[KG-6.3] lets the finding most like the rest stand for its group', () => {
    const group = [
      finding('1', 'run-1', 'logger console missing', 1),
      finding('2', 'run-2', 'logger console', 2),
      finding('3', 'run-3', 'logger console output', 3),
    ];

    expect(representative(group).id).toBe('2');
  });

  it('[KG-6.3] places a file in the deepest module holding it, and reads its line', () => {
    const mappings = [
      { moduleId: 'repo', pathPrefixes: [] },
      { moduleId: 'api', pathPrefixes: ['apps/api/'] },
      { moduleId: 'cache', pathPrefixes: ['/apps/api/src/cache'] },
    ];

    expect(moduleOfPath(mappings, 'apps/api/src/cache/keys.ts')).toBe('cache');
    expect(moduleOfPath(mappings, 'apps/api/main.ts')).toBe('api');
    expect(moduleOfPath(mappings, 'README.md')).toBe('repo');
    expect(moduleOfPath(mappings.slice(1), 'README.md')).toBeNull();

    expect(lineOf('see apps/a.ts:42 and apps/b.ts:7', 'apps/b.ts')).toBe(7);
    expect(lineOf('apps/a.ts:0', 'apps/a.ts')).toBeNull();
    expect(lineOf('apps/a.ts', 'apps/a.ts')).toBeNull();
    // A path's dots are dots, not any character.
    expect(lineOf('apps/aXts:9', 'apps/a.ts')).toBeNull();
  });
});
