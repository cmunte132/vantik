import { readdir } from 'fs/promises';
import { join } from 'path';

import { BadRequestException } from '@nestjs/common';

import { resolveRepositoryPath } from './repositories';
import { type PluginContext } from 'plugins/plugin.interface';

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
const MANIFESTS = [
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
];

/**
 * The directories that hold build output or dependencies of other people.
 *
 * No module owns one of these, and a monorepo has hundreds of them. This
 * function skips each one, and it skips every name that starts with a period.
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

/**
 * This function returns the folders of one local repository.
 *
 * It reads the root of the repository, and it reads one level inside each
 * directory that has no manifest of its own. A monorepo keeps its code in
 * `apps` and in `packages`, and those two names alone are no use to a person
 * who must pick the folder of one service. The second level gives that person
 * `apps/server/` and `packages/types/`.
 *
 * The caller gives a workspace, and this function reads the path from the
 * repositories of that workspace. A member of one workspace cannot read a
 * directory that another workspace added, and nobody can name a path directly.
 */
export async function listRepositoryFolders(
  ctx: PluginContext,
  workspaceId: string,
  repositoryId: string,
): Promise<RepositoryFolder[]> {
  const root = await resolveRepositoryPath(ctx, workspaceId, repositoryId);

  if (!root) {
    throw new BadRequestException(
      'This workspace has no local repository with that id.',
    );
  }

  const folders: RepositoryFolder[] = [];
  const top = await readDirectories(root);

  for (const name of top) {
    if (folders.length >= LIMIT) {
      break;
    }

    const isProject = await hasManifest(join(root, name));

    folders.push({ path: `${name}/`, isProject, depth: 1 });

    // A directory with a manifest is a scope on its own. This function does
    // not look inside it, because a module that owns the package owns every
    // file of it.
    if (isProject) {
      continue;
    }

    const children = await readDirectories(join(root, name));

    for (const child of children) {
      if (folders.length >= LIMIT) {
        break;
      }

      folders.push({
        path: `${name}/${child}/`,
        isProject: await hasManifest(join(root, name, child)),
        depth: 2,
      });
    }
  }

  return folders;
}

/**
 * This function returns the names of the directories inside one path.
 *
 * A path that this server cannot read gives an empty list. A repository with a
 * directory that has no read permission is still usable, and one such
 * directory must not stop the whole answer.
 */
async function readDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });

    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !NOISE.has(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function hasManifest(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);

    return entries.some((entry) => MANIFESTS.includes(entry));
  } catch {
    return false;
  }
}
