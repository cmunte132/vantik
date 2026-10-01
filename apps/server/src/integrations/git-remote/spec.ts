/**
 * This function returns the specification of the git remote integration.
 *
 * A git remote is a Forgejo, Gitea or GitLab host, or any other host that
 * serves git over HTTP or HTTPS. The specification declares `git_remote` and
 * no OAuth2 flow. The settings page reads that field, and it shows a form for
 * the address of the host and a token.
 */
export function spec() {
  return {
    git_remote: {
      instruction:
        'Connect a Forgejo, Gitea or GitLab host, or any git host that serves HTTP or HTTPS. Give an access token that can read and write the repositories.',
    },
  };
}
