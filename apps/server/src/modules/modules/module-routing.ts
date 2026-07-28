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
