export function spec() {
  return {
    workspace_auth: {
      OAuth2: {
        authorization_url: 'https://app.vantik.dev/api/v1/oauth/callback/email',
        token_url: 'https://app.vantik.dev/api/v1/oauth/callback/email',
        scopes: [''],
      },
    },
  };
}
