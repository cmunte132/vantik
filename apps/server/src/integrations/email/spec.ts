export function spec() {
  return {
    workspace_auth: {
      OAuth2: {
        authorization_url: 'https://app.vantik.dev/api/v1/oauth/callback/email',
        token_url: 'https://app.vantik.dev/api/v1/oauth/callback/email',
        scopes: [''],
      },
    },
    team_mappings: {
      source: 'address',
      instruction:
        'Mail sent to you+workspace-tag@ lands in triage of the team paired with its tag, where workspace is this workspace’s slug.',
    },
  };
}
