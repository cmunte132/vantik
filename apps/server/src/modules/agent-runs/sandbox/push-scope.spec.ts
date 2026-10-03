import { scopeViolations } from './push-scope';

describe('scopeViolations', () => {
  it('allows what is inside the prefixes and refuses the rest', () => {
    expect(
      scopeViolations(
        ['apps/server/a.ts', 'packages/types/b.ts'],
        ['apps/server/'],
      ),
    ).toEqual([{ file: 'packages/types/b.ts', reason: 'outside-modules' }]);
  });

  it('treats no prefixes as the whole repository', () => {
    expect(scopeViolations(['anything/at/all.ts'], [])).toEqual([]);
  });

  it('refuses CI configuration whatever the prefixes', () => {
    expect(
      scopeViolations(
        [
          '.github/workflows/ci.yml',
          '.gitlab-ci.yml',
          'Jenkinsfile',
          '.woodpecker.yml',
        ],
        [],
      ).map((v) => v.reason),
    ).toEqual(['protected', 'protected', 'protected', 'protected']);
  });

  it('does not mistake a file that merely mentions CI for CI configuration', () => {
    expect(
      scopeViolations(
        ['docs/github/workflows.md', 'src/.gitlab-ci.yml.ts'],
        [],
      ),
    ).toEqual([]);
  });
});
