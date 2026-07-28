import { randomUUID } from 'crypto';
import { stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, isAbsolute, join, resolve, sep } from 'path';

import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createIntegrationAccount } from 'integrations/utils';

export const LOCAL_REPO_SLUG = 'local-repo';

/**
 * One git repository on the disk of this machine.
 *
 * The `id` and the `fullName` fields have the names that the repository picker
 * of a module reads. That picker takes every connected account and shows the
 * `repositories` array of its settings, so a local repository appears beside a
 * repository of any other source.
 */
export interface LocalRepository {
  /** A stable identifier. A `ModuleRepo` row keeps it as `externalRepoId`. */
  id: string;

  /** The name of the directory. The picker shows it. */
  fullName: string;

  /** The absolute path. An agent opens the checkout here. */
  path: string;

  addedAt: string;
}

interface AccountSettings {
  repositories?: LocalRepository[];
}

/**
 * This function returns the local repositories of one workspace.
 */
export async function listRepositories(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<LocalRepository[]> {
  const definition = await findDefinition(prisma);

  if (!definition) {
    return [];
  }

  const account = await findAccount(prisma, workspaceId, definition.id);

  return account ? readRepositories(account.settings) : [];
}

/**
 * This function adds one directory to the local repositories of a workspace.
 *
 * It makes the integration account of the workspace if there is none. The
 * checks on the path happen before the write, so a bad path never reaches the
 * database.
 */
export async function addRepository(
  prisma: PrismaClient,
  parameters: { workspaceId: string; userId: string; path: string },
): Promise<LocalRepository> {
  const definition = await requireDefinition(prisma);
  const path = await inspectPath(parameters.path);

  const account = await findAccount(
    prisma,
    parameters.workspaceId,
    definition.id,
  );
  const repositories = readRepositories(account?.settings);

  const existing = repositories.find((repository) => repository.path === path);

  if (existing) {
    throw new BadRequestException(
      `This workspace already has ${path} as a local repository.`,
    );
  }

  const repository: LocalRepository = {
    id: randomUUID(),
    fullName: basename(path),
    path,
    addedAt: new Date().toISOString(),
  };

  await writeRepositories(prisma, {
    workspaceId: parameters.workspaceId,
    userId: parameters.userId,
    definitionId: definition.id,
    repositories: [...repositories, repository],
  });

  return repository;
}

/**
 * This function removes one directory from the local repositories.
 *
 * It removes nothing from the disk. A module that links the repository keeps
 * its `ModuleRepo` row, and that row then names a repository that the
 * workspace no longer offers.
 */
export async function removeRepository(
  prisma: PrismaClient,
  parameters: { workspaceId: string; userId: string; repositoryId: string },
): Promise<LocalRepository> {
  const definition = await requireDefinition(prisma);
  const account = await findAccount(
    prisma,
    parameters.workspaceId,
    definition.id,
  );
  const repositories = readRepositories(account?.settings);

  const repository = repositories.find(
    (candidate) => candidate.id === parameters.repositoryId,
  );

  if (!repository) {
    throw new BadRequestException(
      'This workspace has no local repository with that id.',
    );
  }

  await writeRepositories(prisma, {
    workspaceId: parameters.workspaceId,
    userId: parameters.userId,
    definitionId: definition.id,
    repositories: repositories.filter(
      (candidate) => candidate.id !== parameters.repositoryId,
    ),
  });

  return repository;
}

/**
 * This function returns the path of one local repository, or null.
 *
 * A `ModuleRepo` row holds the identifier of the repository and not its path.
 * Anything that needs the checkout reads the path here.
 */
export async function resolveRepositoryPath(
  prisma: PrismaClient,
  workspaceId: string,
  repositoryId: string,
): Promise<string | null> {
  const repositories = await listRepositories(prisma, workspaceId);
  const repository = repositories.find(
    (candidate) => candidate.id === repositoryId,
  );

  return repository ? repository.path : null;
}

/**
 * The directory that a repository path must sit inside.
 *
 * `LOCAL_REPO_ROOT` sets it. With the variable unset the root is the home
 * directory of the account that runs the server, and not the whole disk: a
 * checkout lives in somebody's home directory, and `/etc`, `/proc` and the rest
 * of the filesystem are never the answer to "where is my repository?".
 *
 * There is no way to turn the fence off, because the alternative to a wrong
 * root is a right root and not an open one.
 */
export function repositoryRoot(): string {
  return resolve(process.env.LOCAL_REPO_ROOT || homedir());
}

/**
 * This function checks one path and returns it in its absolute form.
 *
 * It throws a `BadRequestException` with the reason if the path is not a git
 * repository that this server can read, or if it falls outside
 * `repositoryRoot()`. The message names the path, because the person who typed
 * it is the person who reads the message.
 *
 * The containment check runs before any read of the disk. Nothing here reaches
 * the filesystem until the path is known to be inside the root, so a path that
 * is refused cannot report whether it existed.
 */
export async function inspectPath(candidate: string): Promise<string> {
  const trimmed = (candidate ?? '').trim();

  if (!trimmed) {
    throw new BadRequestException('Give the path of a repository.');
  }

  const expanded = trimmed.startsWith('~/')
    ? join(homedir(), trimmed.slice(2))
    : trimmed;

  if (!isAbsolute(expanded)) {
    throw new BadRequestException(
      `${trimmed} is a relative path. Give the absolute path, because the server has no directory of its own to start from.`,
    );
  }

  // `resolve` collapses every `..` before the comparison, so a path that climbs
  // out of the root fails the check rather than reaching the disk.
  const path = resolve(expanded);
  const root = repositoryRoot();
  const prefix = root.endsWith(sep) ? root : root + sep;

  // One test, on `path` itself, and nothing joined to it. The shape matters as
  // much as the result: `a && b` leaves a disjunction on the branch that
  // carries on, so neither a reader nor an analyser can say which half held,
  // and a test on `` `${path}${sep}` `` is a statement about a different string
  // than the one that goes on to the disk. This one says the path is under the
  // root, and it says it about the value that `stat` is given.
  //
  // The root itself does not pass, because the prefix ends in a separator. That
  // is the right answer: the root is the directory the repositories sit in, not
  // a repository.
  if (!path.startsWith(prefix)) {
    throw new BadRequestException(
      `This server takes repositories only from inside ${root}. Set LOCAL_REPO_ROOT to move that directory.`,
    );
  }

  const directory = await statOrNull(path);

  if (!directory) {
    throw new BadRequestException(
      `There is no ${path} on the machine that runs this server.`,
    );
  }

  if (!directory.isDirectory()) {
    throw new BadRequestException(`${path} is a file and not a directory.`);
  }

  // A worktree and a submodule have a `.git` file. A normal clone has a `.git`
  // directory. Both are repositories, so this check accepts each of them.
  const git = await statOrNull(join(path, '.git'));

  if (!git) {
    throw new BadRequestException(
      `${path} has no .git, so it is not a git repository.`,
    );
  }

  return path;
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function findDefinition(prisma: PrismaClient) {
  return await prisma.integrationDefinitionV2.findFirst({
    where: { slug: LOCAL_REPO_SLUG, deleted: null },
  });
}

async function requireDefinition(prisma: PrismaClient) {
  const definition = await findDefinition(prisma);

  if (!definition) {
    throw new BadRequestException(
      'This deployment has no local repository integration. Restart the server, because the seed writes the row at start.',
    );
  }

  return definition;
}

async function findAccount(
  prisma: PrismaClient,
  workspaceId: string,
  definitionId: string,
) {
  return await prisma.integrationAccount.findFirst({
    where: {
      workspaceId,
      integrationDefinitionId: definitionId,
      deleted: null,
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readRepositories(settings: any): LocalRepository[] {
  const parsed: AccountSettings =
    typeof settings === 'string' ? JSON.parse(settings) : (settings ?? {});

  return parsed?.repositories ?? [];
}

/**
 * This function writes the list back on to the account of the workspace.
 *
 * The account is one for each workspace, and its `accountId` is the identifier
 * of the workspace. The upsert makes the account at the first repository, so
 * an empty account never exists.
 */
async function writeRepositories(
  prisma: PrismaClient,
  parameters: {
    workspaceId: string;
    userId: string;
    definitionId: string;
    repositories: LocalRepository[];
  },
) {
  await createIntegrationAccount(prisma, {
    userId: parameters.userId,
    accountId: parameters.workspaceId,
    workspaceId: parameters.workspaceId,
    integrationDefinitionId: parameters.definitionId,
    config: {},
    settings: { repositories: parameters.repositories },
    personal: false,
  });
}
