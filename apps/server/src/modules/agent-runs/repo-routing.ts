import { LOCAL_REPO_SLUG } from 'integrations/local-repo/repositories';

/**
 * A `ModuleRepo` row, reduced to what the choice below needs.
 */
export interface RoutableRepo {
  externalRepoId: string;
  fullName: string;
  integrationAccountId: string | null;
  pathPrefixes: string[];
}

/**
 * The repository an issue's modules point at, or why there is no answer.
 *
 * `prefixes` is the part of that repository the modules claim. An empty list
 * means the whole of it, which is what a service repository looks like and
 * what a module with no prefixes recorded means.
 */
export interface RepoChoice {
  repo: RoutableRepo;
  prefixes: string[];
}

/**
 * This function chooses the repository that a set of `ModuleRepo` rows agree
 * on.
 *
 * A module says where its code is, so an issue filed against a module already
 * answers "which checkout does the agent open?". Nothing else has to be
 * configured, and a workspace with several repositories stops sending every
 * run to whichever one the workspace default names.
 *
 * Two modules on one repository is the ordinary case for a monorepo, and the
 * prefixes of both are kept: an issue against the server and the webapp is an
 * issue about `apps/server/` and `apps/webapp/`. One row with no prefixes
 * widens the answer to the whole repository, because that row says the module
 * is all of it.
 *
 * Two modules on *different* repositories has no right answer, so this returns
 * null rather than picking one. A run in the wrong repository costs more than
 * a run that did not start.
 */
export function chooseRepo(repos: RoutableRepo[]): RepoChoice | null {
  const live = repos.filter((repo) => repo.externalRepoId);

  if (live.length === 0) {
    return null;
  }

  const distinct = new Set(live.map((repo) => repo.externalRepoId));

  if (distinct.size > 1) {
    return null;
  }

  const claimsWholeRepo = live.some((repo) => repo.pathPrefixes.length === 0);

  return {
    repo: live[0],
    prefixes: claimsWholeRepo
      ? []
      : [...new Set(live.flatMap((repo) => repo.pathPrefixes))].sort(),
  };
}

/**
 * This function returns the remote to clone for a repository that is not on
 * this disk, or null.
 *
 * Only the sources that this server knows how to name are answered. A source
 * whose URL cannot be built from a full name gets null rather than a guess,
 * and the run then falls back to whatever the workspace configured.
 */
export function remoteUrlFor(
  definitionSlug: string | null,
  fullName: string,
): string | null {
  if (definitionSlug === 'github') {
    return `https://github.com/${fullName}.git`;
  }

  return null;
}

/** True when an integration account holds repositories on this machine. */
export function isLocalSource(definitionSlug: string | null): boolean {
  return definitionSlug === LOCAL_REPO_SLUG;
}
