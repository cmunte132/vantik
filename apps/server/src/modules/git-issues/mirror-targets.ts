/**
 * Which repositories carry an issue mirror, and for which teams.
 *
 * The mirror does not know where a repository comes from. A tier of source
 * (a local directory, a git remote) supplies a `MirrorTargets` that lists the
 * repositories of that tier which an admin opted in. The service resolves each
 * one through `GitSourcesService`, the same way every other reader of a
 * repository does, so a new tier needs a new list and no change to the pass.
 */
export interface MirroredRepository {
  workspaceId: string;
  /** The integration account that offers the repository. */
  integrationAccountId: string;
  /** The identifier that the account gives the repository. */
  externalRepoId: string;
  /** What the log calls the repository. Never a secret. */
  label: string;
  /** The teams whose issues the repository carries. */
  teamIds: string[];
}

export interface MirrorTargets {
  /** The opted-in repositories of this tier, in every workspace. */
  list(): Promise<MirroredRepository[]>;
}

/** The injection token for the list of every `MirrorTargets`. */
export const GIT_ISSUES_TARGETS = 'GIT_ISSUES_TARGETS';
