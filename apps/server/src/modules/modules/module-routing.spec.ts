import {
  mergeModuleIds,
  modulesForChangedPaths,
  pathBelongsToModule,
  type RepoModuleMapping,
} from './module-routing';

/**
 * These functions decide which module a pull request changed. A module that
 * they miss leaves an issue untagged, and a module that they add wrongly points
 * a reader at code that the pull request never touched.
 *
 * Each test below names the rule from ENG-75 that it holds.
 */

describe('pathBelongsToModule', () => {
  it('matches a path under one of the prefixes', () => {
    expect(
      pathBelongsToModule('apps/server/src/main.ts', ['apps/server/']),
    ).toBe(true);
  });

  it('refuses a path under no prefix', () => {
    expect(
      pathBelongsToModule('apps/webapp/src/page.tsx', ['apps/server/']),
    ).toBe(false);
  });

  /**
   * A module whose ModuleRepo has empty pathPrefixes resolves for any changed
   * path in that repository. This is the microservice shape: one repository
   * holds one module.
   */
  it('matches every path when the prefix list is empty', () => {
    expect(pathBelongsToModule('anything/at/all.ts', [])).toBe(true);
    expect(pathBelongsToModule('README.md', [])).toBe(true);
  });

  /**
   * The trailing slash is what separates a folder from a folder whose name
   * starts with the same letters. Without it, the module that owns
   * `apps/server` also claims every file of `apps/server-extra`.
   */
  it('does not let one folder claim a folder with a longer name', () => {
    expect(
      pathBelongsToModule('apps/server-extra/src/main.ts', ['apps/server/']),
    ).toBe(false);
  });

  it('adds the trailing slash that an older row can miss', () => {
    expect(
      pathBelongsToModule('apps/server/src/main.ts', ['apps/server']),
    ).toBe(true);
    expect(
      pathBelongsToModule('apps/server-extra/src/main.ts', ['apps/server']),
    ).toBe(false);
  });

  it('reads a leading slash on either side', () => {
    expect(
      pathBelongsToModule('/apps/server/src/main.ts', ['/apps/server/']),
    ).toBe(true);
  });

  it('refuses an empty path', () => {
    expect(pathBelongsToModule('', [])).toBe(false);
    expect(pathBelongsToModule('   ', ['apps/server/'])).toBe(false);
  });

  it('matches a path under the second prefix of a module', () => {
    expect(
      pathBelongsToModule('packages/ui/button.tsx', [
        'apps/webapp/',
        'packages/ui/',
      ]),
    ).toBe(true);
  });
});

describe('modulesForChangedPaths', () => {
  const server = { moduleId: 'module-server', pathPrefixes: ['apps/server/'] };
  const webapp = {
    moduleId: 'module-webapp',
    pathPrefixes: ['apps/webapp/', 'packages/ui/'],
  };

  /** A pull request touching paths under one module's prefixes sets that module. */
  it('returns the one module that the pull request changed', () => {
    expect(
      modulesForChangedPaths(
        [server, webapp],
        ['apps/server/src/main.ts', 'apps/server/package.json'],
      ),
    ).toEqual(['module-server']);
  });

  /** A pull request touching two modules' prefixes sets both modules. */
  it('returns both modules when the pull request crosses them', () => {
    expect(
      modulesForChangedPaths(
        [server, webapp],
        ['apps/server/src/main.ts', 'packages/ui/button.tsx'],
      ),
    ).toEqual(['module-server', 'module-webapp']);
  });

  /** A webhook for a repository with no ModuleRepo row assigns nothing. */
  it('returns nothing when the repository maps to no module', () => {
    expect(modulesForChangedPaths([], ['apps/server/src/main.ts'])).toEqual([]);
  });

  it('returns nothing when the changed paths reach no module', () => {
    expect(
      modulesForChangedPaths([server, webapp], ['docs/readme.md']),
    ).toEqual([]);
  });

  it('returns nothing when the pull request changed no file', () => {
    expect(modulesForChangedPaths([server, webapp], [])).toEqual([]);
  });

  /**
   * A repository can hold one module that takes everything and another that
   * takes a folder. The whole-repository module then answers for every path.
   */
  it('returns a whole-repository module beside a folder module', () => {
    const everything: RepoModuleMapping = {
      moduleId: 'module-all',
      pathPrefixes: [],
    };

    expect(
      modulesForChangedPaths([everything, server], ['apps/server/src/main.ts']),
    ).toEqual(['module-all', 'module-server']);
  });

  it('names a module once when two of its prefixes match', () => {
    expect(
      modulesForChangedPaths(
        [webapp],
        ['apps/webapp/src/page.tsx', 'packages/ui/button.tsx'],
      ),
    ).toEqual(['module-webapp']);
  });

  it('names a module once when two rows point at it', () => {
    const first = { moduleId: 'module-server', pathPrefixes: ['apps/server/'] };
    const second = {
      moduleId: 'module-server',
      pathPrefixes: ['packages/db/'],
    };

    expect(
      modulesForChangedPaths(
        [first, second],
        ['apps/server/src/main.ts', 'packages/db/schema.ts'],
      ),
    ).toEqual(['module-server']);
  });
});

describe('mergeModuleIds', () => {
  /** A module a person set by hand survives a pull request for another module. */
  it('keeps a module that a person set by hand', () => {
    expect(mergeModuleIds(['module-chosen'], ['module-server'])).toEqual([
      'module-chosen',
      'module-server',
    ]);
  });

  it('adds the resolved modules to an issue that had none', () => {
    expect(mergeModuleIds([], ['module-server', 'module-webapp'])).toEqual([
      'module-server',
      'module-webapp',
    ]);
  });

  it('holds one entry for a module that both lists name', () => {
    expect(mergeModuleIds(['module-server'], ['module-server'])).toEqual([
      'module-server',
    ]);
  });

  it('leaves the list alone when the pull request resolved nothing', () => {
    expect(mergeModuleIds(['module-chosen'], [])).toEqual(['module-chosen']);
  });

  it('returns an empty list when there is nothing on either side', () => {
    expect(mergeModuleIds([], [])).toEqual([]);
  });
});
