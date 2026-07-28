export interface GithubRepositories {
  id: string;
  fullName: string;
}

/**
 * The settings hold the repositories that a workspace connected, and nothing
 * about who owns them.
 *
 * A `repositoryMappings` list lived here, and each entry carried a `teamId`.
 * That single field is what made one workspace mean one product: a repository
 * belonged to a team, and a team was the only axis there was. A repository now
 * maps to a module through `ModuleRepo`, which the server holds and the client
 * reads over REST. One repository can therefore serve several modules, each
 * with its own folders.
 */
export interface GithubSettings {
  orgLogin: string;
  orgAvatarURL: string;
  repositories: GithubRepositories[];
}

export interface GithubPersonalSettings {
  login: string;
}

export interface IntegrationAccountType {
  id: string;
  createdAt: string;
  updatedAt: string;

  accountId: string | null;
  settings: string | null;
  personal: boolean;

  integratedById: string;
  integrationDefinitionId: string;
  workspaceId: string;
}
