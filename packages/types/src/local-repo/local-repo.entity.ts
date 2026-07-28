/**
 * One git repository on the disk of the machine that runs the server.
 *
 * The `id` and the `fullName` fields carry the names that the repository
 * picker of a module reads. A local repository then appears in that picker
 * beside a repository that came from a remote source.
 */
export class LocalRepository {
  /** A stable identifier. A `ModuleRepo` row keeps it as `externalRepoId`. */
  id: string;

  /** The name of the directory. */
  fullName: string;

  /** The absolute path of the directory. */
  path: string;

  addedAt: string;
}

/**
 * One directory inside a repository that a module can claim.
 *
 * A service repository keeps all of its code at the root, and it has no
 * folder here that a module needs. A monorepo has one folder for each package
 * and for each application, and a module takes one of them.
 */
export class RepositoryFolder {
  /** Relative to the root of the repository. It ends with a slash. */
  path: string;

  /** The directory holds the manifest of a package or of an application. */
  isProject: boolean;

  /** 1 for a directory at the root. 2 for a directory inside one of those. */
  depth: number;
}
