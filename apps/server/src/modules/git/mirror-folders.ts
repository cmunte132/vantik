import { git } from './git-command';

/**
 * One directory in a repository that a module can claim.
 *
 * The `path` field has the form that a `ModuleRepo` row keeps: it is relative
 * to the root of the repository, and it ends with a slash.
 */
export interface RepositoryFolder {
  path: string;

  /**
   * The directory holds a manifest of a package or an application. A monorepo
   * has many of them, and each one is a good scope for a module. A service
   * repository has one at its root, and then this list has none.
   */
  isProject: boolean;

  /** 1 for a directory at the root. 2 for a directory inside one of those. */
  depth: number;
}

/**
 * The names of the files that mark the root of a project.
 *
 * The list is short on purpose. It answers one question: does somebody build
 * something from this directory? A directory that holds only other directories
 * gets a look inside instead.
 */
const MANIFESTS = new Set([
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
]);

/**
 * The directories that hold build output or dependencies of other people.
 *
 * No module owns one of these. Each one is skipped, and so is every name that
 * starts with a period.
 */
const NOISE = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  'tmp',
  'temp',
  '__pycache__',
  'venv',
]);

/** The most folders that one answer holds. A deep monorepo stops here. */
const LIMIT = 300;

interface Entry {
  type: string;
  path: string;
}

/**
 * The folders of a repository at one commit, read from the mirror.
 *
 * The root, and one level inside each directory that has no manifest of its
 * own. A monorepo keeps its code in `apps` and in `packages`, and those two
 * names alone are no use to a person who must pick the folder of one service.
 * The second level gives that person `apps/server/` and `packages/types/`.
 *
 * Committed files only, so what a person has not committed, and what git
 * ignores, is never offered. Three `ls-tree` calls in all, whatever the size.
 */
export async function foldersOf(
  mirror: string,
  ref: string,
): Promise<RepositoryFolder[]> {
  const top = directories(await list(mirror, ref, null));
  const firstLevel = await list(
    mirror,
    ref,
    top.map((name) => `${name}/`),
  );
  const projects = manifestHolders(firstLevel);

  const nested = top.filter((name) => !projects.has(name));
  const children = directories(
    firstLevel.filter((entry) =>
      nested.some((name) => entry.path.startsWith(`${name}/`)),
    ),
  );
  const secondLevel = await list(
    mirror,
    ref,
    children.map((path) => `${path}/`),
  );
  const nestedProjects = manifestHolders(secondLevel);

  const folders: RepositoryFolder[] = [];

  for (const name of top) {
    if (folders.length >= LIMIT) {
      break;
    }

    folders.push({ path: `${name}/`, isProject: projects.has(name), depth: 1 });

    // A directory with a manifest is a scope on its own. A module that owns
    // the package owns every file of it.
    if (projects.has(name)) {
      continue;
    }

    for (const child of children.filter((path) =>
      path.startsWith(`${name}/`),
    )) {
      if (folders.length >= LIMIT) {
        break;
      }

      folders.push({
        path: `${child}/`,
        isProject: nestedProjects.has(child),
        depth: 2,
      });
    }
  }

  return folders;
}

/** The entries directly inside each of `paths`, or at the root for null. */
async function list(
  mirror: string,
  ref: string,
  paths: string[] | null,
): Promise<Entry[]> {
  if (paths?.length === 0) {
    return [];
  }

  const out = await git(
    ['--literal-pathspecs', 'ls-tree', '-z', ref, '--', ...(paths ?? [])],
    { cwd: mirror },
  ).catch((): string => '');

  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [, type] = line.slice(0, tab).split(' ');

      return { type, path: line.slice(tab + 1) };
    });
}

/** The directory paths among `entries`, without noise, sorted. */
function directories(entries: Entry[]): string[] {
  return entries
    .filter((entry) => entry.type === 'tree')
    .map((entry) => entry.path)
    .filter((path) => {
      const name = path.split('/').pop() ?? '';

      return !name.startsWith('.') && !NOISE.has(name);
    })
    .sort();
}

/** The directories among `entries`' parents that hold a manifest. */
function manifestHolders(entries: Entry[]): Set<string> {
  const holders = new Set<string>();

  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');

    if (entry.type === 'blob' && MANIFESTS.has(entry.path.slice(slash + 1))) {
      holders.add(entry.path.slice(0, slash));
    }
  }

  return holders;
}
