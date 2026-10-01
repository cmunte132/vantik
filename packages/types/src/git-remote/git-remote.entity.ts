/**
 * The kinds of git host that a remote connection can be.
 *
 * Forgejo and Gitea have the same API. GitLab has a different API. A generic
 * host has no API that Vantik knows, so it gives git access and nothing more.
 */
export const GIT_REMOTE_KINDS = ['forgejo', 'gitea', 'gitlab', 'generic'] as const;

export type GitRemoteKind = (typeof GIT_REMOTE_KINDS)[number];

/**
 * One repository that a remote connection offers to the workspace.
 *
 * The `id` and the `fullName` fields have the names that the repository picker
 * of a module reads. A remote repository then appears in that picker beside a
 * local repository and a GitHub repository.
 */
export class GitRemoteRepository {
  /**
   * The identifier that the host gives the repository. A generic host has no
   * identifier, so Vantik makes one. A `ModuleRepo` row keeps it as
   * `externalRepoId`.
   */
  id: string;

  /** The path of the repository on the host, for example `owner/name`. */
  fullName: string;

  /** The HTTPS or HTTP address that git fetches from and pushes to. */
  cloneUrl: string;

  /** The page of the repository on the host, if the host has one. */
  webUrl?: string;

  /** The default branch that the host gave when the repository was added. */
  defaultBranch?: string;

  addedAt: string;
}

/**
 * One git host that the workspace connected.
 *
 * The response never holds the token. It holds only `tokenHint`, which shows
 * the last characters of a long token.
 */
export class GitRemoteConnection {
  /** The id of the integration account. */
  id: string;

  kind: GitRemoteKind;

  /** The address of the host, for example `https://forgejo.example.com`. */
  baseUrl: string;

  /** The user name that git sends with the token. */
  username: string;

  hasToken: boolean;

  tokenHint: string | null;

  repositories: GitRemoteRepository[];

  createdAt: string;
}

/** One repository that the host API offers, for the add picker. */
export class AvailableGitRemoteRepository {
  id: string;

  fullName: string;

  defaultBranch?: string;

  private: boolean;

  /** True if the connection already has this repository. */
  added: boolean;
}
