export const githubHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

export interface GithubRepositories {
  id: string;
  fullName: string;
  name: string;
  private: boolean;
}

/**
 * A `mappings` list lived here, and each entry carried a `teamId`. A repository
 * now maps to a module through `ModuleRepo`, and `ModuleRoutingService` reads
 * those rows once for each webhook.
 */
export interface GithubIntegrationSettings {
  orgAvatarURL: string;
  orgLogin: string;
  repositories: GithubRepositories[];
}

export interface GithubPersonalIntegrationSettings {
  login: string;
}
