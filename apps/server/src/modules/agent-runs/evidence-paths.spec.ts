import {
  evidencePaths,
  MAX_EVIDENCE_PATHS,
  MAX_EVIDENCE_TEXT,
} from './evidence-paths';

/**
 * The files a finding or a failing check names, which is how a run's outcome
 * is traced back to the knowledge it was handed.
 */
describe('the files a piece of evidence names', () => {
  it('[KG-3.4] reads a path from a finding, without its line and column', () => {
    expect(
      evidencePaths(
        'src/modules/pages/knowledge.service.ts:42:7 drops the workspace filter',
      ),
    ).toEqual(['src/modules/pages/knowledge.service.ts']);
  });

  it('[KG-3.4] reads every file a failing check printed, first mention first, once each', () => {
    const output = [
      'FAIL src/a.spec.ts',
      '  at Object.<anonymous> (src/a.spec.ts:10:5)',
      'error TS2345 in apps/server/src/b.ts(3,1)',
      'FAIL src/a.spec.ts',
    ].join('\n');

    expect(evidencePaths(output)).toEqual([
      'src/a.spec.ts',
      'apps/server/src/b.ts',
    ]);
  });

  it('[KG-3.4] makes a path in the sandbox checkout relative to the repository', () => {
    expect(
      evidencePaths('/workspace/repo/packages/types/src/index.ts: error'),
    ).toEqual(['packages/types/src/index.ts']);
  });

  it('[KG-3.4] drops paths outside the repository, which no entry cites', () => {
    expect(
      evidencePaths(
        [
          '/usr/lib/node_modules/npm/index.js',
          '/root/.cache/pnpm/lodash.js',
          '../other-repo/src/x.ts',
        ].join(' '),
      ),
    ).toEqual([]);
  });

  it('[KG-3.4] strips a leading ./ so the path compares with a citation', () => {
    expect(evidencePaths('see ./src/thing.ts and ././lib/x.js')).toEqual([
      'src/thing.ts',
      'lib/x.js',
    ]);
  });

  it('[KG-3.4] reads files with dotted and scoped names', () => {
    expect(
      evidencePaths(
        '`node_modules/@vantikhq/types/dist/index.d.ts` and .github/workflows/ci.yml',
      ),
    ).toEqual([
      'node_modules/@vantikhq/types/dist/index.d.ts',
      '.github/workflows/ci.yml',
    ]);
  });

  it('[KG-3.4] reads dotfiles, and dotted folders anywhere in a path', () => {
    expect(
      evidencePaths(
        'apps/server/.env, config/.eslintrc.json and /workspace/repo/.claude/skills/x.md',
      ),
    ).toEqual([
      'apps/server/.env',
      'config/.eslintrc.json',
      '.claude/skills/x.md',
    ]);
  });

  it('[KG-3.4] reads nothing from prose without a file in it, or from nothing', () => {
    expect(evidencePaths('The tests failed with exit code 1')).toEqual([]);
    expect(evidencePaths(null)).toEqual([]);
    expect(evidencePaths(undefined)).toEqual([]);
  });

  it('[KG-3.4] stops at a bound, so a flood of output is not stored', () => {
    const output = Array.from(
      { length: MAX_EVIDENCE_PATHS * 3 },
      (_, index) => `src/file-${index}.ts`,
    ).join('\n');

    const paths = evidencePaths(output);

    expect(paths).toHaveLength(MAX_EVIDENCE_PATHS);
    expect(paths[0]).toBe('src/file-0.ts');
  });

  it('[KG-3.4] reads a long stretch of output with no path in it quickly', () => {
    // The pattern backtracks: over one unbroken run of path characters it is
    // quadratic, so a long one must never reach it.
    const noise = [
      'a'.repeat(MAX_EVIDENCE_TEXT),
      'a/'.repeat(MAX_EVIDENCE_TEXT / 2),
      'a./'.repeat(MAX_EVIDENCE_TEXT / 3),
    ];
    const started = Date.now();

    for (const text of noise) {
      expect(evidencePaths(`${text} src/real.ts`)).toEqual([]);
      expect(evidencePaths(`src/real.ts ${text}`)).toEqual(['src/real.ts']);
    }

    expect(Date.now() - started).toBeLessThan(250);
  });
});
