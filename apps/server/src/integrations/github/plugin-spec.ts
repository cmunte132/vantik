import { type PluginSpec } from 'plugins/plugin.interface';

/**
 * What GitHub declares about itself.
 *
 * `egress` is one host, and it does more work here than for the other vendors.
 * GitHub hands back absolute URLs — a comment's `url`, a pull request's
 * `comments_url` — and those get stored on the linked issue and posted to
 * later. So a call target is sometimes a value that came from outside and has
 * been sitting in the database since. Resolving it and checking the host means
 * a tampered `sourceData` is refused rather than followed.
 *
 * `auth` takes an identity rather than returning one token, because GitHub is
 * the vendor that needs two. A comment syncs as the *person* when they have
 * connected their own account, and as the installation bot when they have not,
 * so that a pull request shows who actually said something instead of
 * attributing everything to one robot. The plugin names which identity; it
 * never sees either token.
 */
export const githubSpec: PluginSpec = {
  slug: 'github',
  baseUrl: 'https://api.github.com',
  egress: ['api.github.com'],
  auth: (account, as) => {
    const config = account?.integrationConfiguration ?? {};
    const token = as === 'bot' ? config.botToken : config.access_token;

    return token ? `Bearer ${token}` : undefined;
  },
};

/** The headers GitHub wants on every call, minus the credential. */
export const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
