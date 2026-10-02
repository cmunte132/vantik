import { type GitRemote } from './git-command';

/**
 * One repository that an integration account offers, resolved and checked.
 *
 * Only `GitSourcesService` makes one. It makes one only when the account
 * belongs to the workspace, is not deleted, and lists the repository in its
 * settings, so a source never sees a repository the workspace did not add.
 */
export interface SourceRepo {
  workspaceId: string;
  integrationAccountId: string;
  /** The `accountId` of the integration account, such as a GitHub installation. */
  accountId: string;
  /** The identifier the source gives the repository. `ModuleRepo` keeps it. */
  externalRepoId: string;
  fullName: string;
  /** The entry for this repository in the account's `settings.repositories`. */
  listing: Record<string, unknown>;
  /**
   * The `integrationConfiguration` of the account. It holds the settings of
   * the connection that are not secret, for example the address of a host.
   */
  config: Record<string, unknown>;
}

/** Who a commit names: as its author, or in a `Co-authored-by` trailer. */
export interface CommitIdentity {
  name: string;
  email: string;
}

export interface ChangeRequest {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/**
 * Where code lives, and the operations that differ from one host to another.
 *
 * Everything else is plain git on the server's own mirror (see
 * `RepoMirrorService`): checkout, file reads, the default branch and the
 * folder list do not depend on the source. A source only says how to reach
 * the repository, and what the host can do beyond git.
 *
 * There are three tiers of source. GitHub has an app installation, webhooks
 * and pull requests. A git remote (Forgejo, Gitea, GitLab, any other host) has
 * a URL and a credential. A local directory has a path on this machine. Each
 * tier is one implementation of this interface, so no caller branches on which
 * one it has.
 */
export interface GitSource {
  /** The `slug` of the integration definition this source implements. */
  readonly slug: string;

  /**
   * Whether the host tells the server when a branch moves. When it does not,
   * the mirror can be stale until the next fetch, and a caller that needs the
   * newest commit fetches first.
   */
  readonly notifies: boolean;

  /** How the server fetches from the repository. The caller disposes it. */
  fetchRemote(repo: SourceRepo): Promise<GitRemote>;

  /** How the server pushes to the repository. The caller disposes it. */
  pushRemote(repo: SourceRepo): Promise<GitRemote>;

  /**
   * The branch work starts from when nothing else names one, or null to take
   * the HEAD the remote advertises. A source overrides this when that HEAD is
   * not the default branch: a working directory advertises the branch that
   * is checked out, which is often a feature branch.
   */
  defaultBranch?(repo: SourceRepo): Promise<string | null>;

  /**
   * Opens a pull request (or a merge request) for a pushed branch and returns
   * its URL. Absent when the host has no such thing, such as a directory on
   * this machine. Then the pushed branch is the handback.
   */
  openChangeRequest?(
    repo: SourceRepo,
    request: ChangeRequest,
  ): Promise<string | undefined>;

  /**
   * This method returns true if `openChangeRequest` can open a pull request
   * for this repository. A source that has no such method does not need it.
   * The git remote source needs it, because a generic host has no API.
   */
  opensChangeRequests?(repo: SourceRepo): boolean;

  /**
   * The author of the commits the server pushes, or null for the default
   * agent identity. A connection that pushes as a bot account names that
   * account, so the host shows the bot as the author and not a person.
   */
  commitAuthor?(repo: SourceRepo): CommitIdentity | null;

  /** Where the repository is, for a person: a URL or a path. Never a secret. */
  location(repo: SourceRepo): string;
}

/**
 * This function returns true if a run on this repository hands back a pull
 * request. If it returns false, the run hands back the pushed branch.
 */
export function deliversPullRequest(
  source: GitSource,
  repo: SourceRepo,
): boolean {
  if (!source.openChangeRequest) {
    return false;
  }

  return source.opensChangeRequests ? source.opensChangeRequests(repo) : true;
}
