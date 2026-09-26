export function spec() {
  return {
    workspace_auth: {
      OAuth2: {
        token_url: 'https://github.com/login/oauth/access_token',
        authorization_url:
          'https://github.com/apps/vantik-bot/installations/new',
        scopes: ['repo'],
      },
    },
    team_mappings: {
      source: 'repository',
      instruction:
        'Pair a team with a repository of the installation. A new issue in the team is opened there too, and its comments sync both ways.',
    },
  };
}
