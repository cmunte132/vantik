/**
 * How a pull request finds the modules it changes.
 *
 * A webhook gives the server the identifier of a repository and the paths of
 * the files that a pull request changed. A `ModuleRepo` row maps a repository
 * to a module, and it holds the path prefixes that belong to that module. These
 * functions turn the one into the other.
 *
 * The functions here read no database and hold no state. The service beside
 * them supplies the rows and writes the result.
 */

/** The part of a `ModuleRepo` row that the resolution needs. */
export interface RepoModuleMapping {
  moduleId: string;
  /**
   * The folders of the repository that belong to this module. An empty list
   * means the module is the whole repository.
   */
  pathPrefixes: string[];
}

/**
 * Makes one path ready for a comparison against a prefix.
 *
 * GitHub sends a path with no leading slash, such as `apps/server/src/main.ts`.
 * Another provider can send `/apps/server/src/main.ts`. This function removes
 * the leading slashes, so that both forms compare the same way.
 */
function normalisePath(path: string): string {
  return path.trim().replace(/^\/+/, '');
}

/**
 * Makes one prefix ready for a comparison against a path.
 *
 * `ModulesService.createModuleRepo` stores a prefix in this form already. A
 * prefix that a migration wrote, or that an older row holds, can miss the
 * trailing slash. The trailing slash is what stops `apps/server` from matching
 * a file in `apps/server-extra`, so this function adds it back.
 */
function normalisePrefix(prefix: string): string {
  const cleaned = prefix.trim().replace(/^\/+/, '');

  if (!cleaned) {
    return '';
  }

  return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
}

/**
 * This function reports whether one changed path belongs to one module.
 *
 * An empty prefix list means the module is the whole repository, so every path
 * in that repository belongs to it. This is the shape of a microservice, where
 * one repository holds one module.
 */
export function pathBelongsToModule(
  path: string,
  pathPrefixes: string[],
): boolean {
  const candidate = normalisePath(path);

  if (!candidate) {
    return false;
  }

  const prefixes = pathPrefixes.map(normalisePrefix).filter(Boolean);

  if (prefixes.length === 0) {
    return true;
  }

  return prefixes.some((prefix) => candidate.startsWith(prefix));
}

/**
 * This function returns the modules that a set of changed paths reaches.
 *
 * A pull request that changes two folders of a monorepo reaches two modules,
 * and the caller gets both. A pull request that changes a folder which no
 * module claims reaches nothing, and the caller gets an empty list.
 *
 * The order of the result follows the order of the mappings. A caller that
 * compares two results therefore does not have to sort them first.
 */
export function modulesForChangedPaths(
  mappings: RepoModuleMapping[],
  changedPaths: string[],
): string[] {
  const reached: string[] = [];

  for (const mapping of mappings) {
    if (reached.includes(mapping.moduleId)) {
      continue;
    }

    const touched = changedPaths.some((path) =>
      pathBelongsToModule(path, mapping.pathPrefixes),
    );

    if (touched) {
      reached.push(mapping.moduleId);
    }
  }

  return reached;
}

/**
 * This function returns the list that `Issue.moduleIds` holds after a pull
 * request.
 *
 * The result is the union of the two lists. A person who sets a module by hand
 * keeps it, even when the pull request changes a different part of the code.
 * That is the rule the model states: a person and a pull request write
 * `Issue.moduleIds`, and the LLM writes `IssueSuggestion.suggestedModuleIds`
 * instead.
 *
 * A union never removes a module. A pull request that drops a folder therefore
 * leaves the module of that folder in place. The other method is to record
 * which modules the last pull request added, and to replace that set. It costs
 * a column, and it can remove the work of a person when the provenance is
 * wrong. A list that is too long is the safer error of the two.
 */
export function mergeModuleIds(
  existing: string[],
  resolved: string[],
): string[] {
  return [...new Set([...existing, ...resolved])];
}

/**
 * A module mapping with the repository it belongs to, which resolving a
 * knowledge scope needs and routing a pull request does not: a pull request
 * arrives from one repository, and a scope names none.
 */
export interface ScopedRepoModuleMapping extends RepoModuleMapping {
  /** The provider's full name of the repository, such as `acme/app`. */
  fullName: string;
}

/** Glob characters. A path segment holding one is a pattern, not a folder. */
const GLOB = /[*?[\]{}]/;

/**
 * The folder a knowledge scope names, or null when it names none.
 *
 * Scopes are written by agents and people, not by a webhook, so they arrive in
 * the shapes people write: `apps/server`, `./apps/server/`, `apps/server/**`,
 * `apps/server/**\/*.ts`. Everything from the first segment holding a glob
 * character is dropped, because the part before it is the folder the pattern
 * lives in, and that is what a module prefix can be compared with. A scope
 * that is only a pattern (`**\/*.prisma`) names no folder.
 */
export function scopePath(scope: string | null | undefined): string | null {
  if (!scope) {
    return null;
  }

  const segments = scope.trim().replace(/^\.\//, '').split('/').filter(Boolean);
  const firstGlob = segments.findIndex((segment) => GLOB.test(segment));
  const folder = firstGlob === -1 ? segments : segments.slice(0, firstGlob);

  return folder.length > 0 ? folder.join('/') : null;
}

/**
 * The folder a scope names and every folder above it, outermost first:
 * `apps/server/prisma` gives `apps`, `apps/server`, `apps/server/prisma`.
 *
 * This is what makes scope matching a prefix match inside the search index,
 * which can test membership in a list but cannot compare prefixes.
 */
export function scopeAncestors(scope: string | null | undefined): string[] {
  const path = scopePath(scope);

  if (!path) {
    return [];
  }

  const segments = path.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * The modules a knowledge scope falls in.
 *
 * The same prefixes that route a pull request's changed files route a scope,
 * with two differences that come from a scope naming a folder rather than a
 * file:
 *
 * - A scope matches a module whose folder it is in or is, which is the file
 *   rule applied to the folder (`apps/server` is in `apps/server/`), and also a
 *   module whose folder is below it: a fact about `apps` is a fact about every
 *   module under `apps`.
 * - A scope names no repository, so a module that is a whole repository (no
 *   prefixes) matches only when that is unambiguous: the scope starts with the
 *   repository's full name, or the workspace has one repository at all.
 *   Otherwise every path in every workspace with two small repositories would
 *   land in both of them.
 */
export function modulesForScope(
  mappings: ScopedRepoModuleMapping[],
  scope: string | null | undefined,
): string[] {
  const path = scopePath(scope);

  if (!path) {
    return [];
  }

  const repositories = [
    ...new Set(mappings.map((mapping) => mapping.fullName)),
  ];
  // The longest name that the path starts with, so `acme/app-extra` is not
  // read as `acme/app` followed by a folder.
  const named = repositories
    .filter((name) => path === name || path.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];

  const candidates = named
    ? mappings.filter((mapping) => mapping.fullName === named)
    : mappings;
  const inRepository = named
    ? path.slice(named.length).replace(/^\/+/, '')
    : path;
  const folder = inRepository ? `${inRepository}/` : '';
  const unambiguous = Boolean(named) || repositories.length === 1;

  const reached: string[] = [];

  for (const mapping of candidates) {
    if (reached.includes(mapping.moduleId)) {
      continue;
    }

    const prefixes = mapping.pathPrefixes.map(normalisePrefix).filter(Boolean);

    const matches =
      prefixes.length === 0
        ? unambiguous
        : // A repository named with no folder is the whole repository.
          !folder ||
          pathBelongsToModule(folder, prefixes) ||
          prefixes.some((prefix) => prefix.startsWith(folder));

    if (matches) {
      reached.push(mapping.moduleId);
    }
  }

  return reached;
}
