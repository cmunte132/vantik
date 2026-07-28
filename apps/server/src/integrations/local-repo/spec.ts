/**
 * This function returns the specification of the local repository integration.
 *
 * A local repository is a directory on the machine that runs this server.
 * There is no third party, so the specification declares `local_auth` and no
 * OAuth2 flow. The settings page reads that field and shows a form in place of
 * a Connect button.
 */
export function spec() {
  return {
    local_auth: {
      instruction:
        'Give the absolute path of a git repository on the machine that runs this server.',
    },
  };
}
