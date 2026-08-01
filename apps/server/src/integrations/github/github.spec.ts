import { githubSpec } from './plugin-spec';
import { relativeTime, toApiUrl } from './sync-utils';

/**
 * The parts of the GitHub port with decisions in them.
 *
 * Not the forwarding — the two rules that would be silently wrong: which
 * identity a call goes out as, and which browser URLs are recognised as GitHub.
 */
describe('the GitHub plugin spec', () => {
  const account = {
    integrationConfiguration: {
      access_token: 'the-person',
      botToken: 'the-installation',
    },
  };

  /**
   * The reason `as` exists on the contract at all. A comment syncs as the
   * person when they have connected their own account, so a pull request shows
   * who actually said something rather than attributing everything to one bot.
   */
  it('picks the identity the plugin asked for', () => {
    expect(githubSpec.auth?.(account, 'user')).toBe('Bearer the-person');
    expect(githubSpec.auth?.(account, 'bot')).toBe('Bearer the-installation');
  });

  it('gives nothing when the account holds no such token', () => {
    expect(githubSpec.auth?.({ integrationConfiguration: {} }, 'bot')).toBeUndefined();
    expect(githubSpec.auth?.(null, 'user')).toBeUndefined();
  });

  /** One host, and the egress check is what makes stored URLs safe to call. */
  it('allows exactly one host', () => {
    expect(githubSpec.egress).toEqual(['api.github.com']);
  });
});

describe('turning a browser URL into an API URL', () => {
  it('knows that a pull is pulls', () => {
    expect(toApiUrl('https://github.com/acme/web/pull/42')).toBe(
      'https://api.github.com/repos/acme/web/pulls/42',
    );
  });

  it('leaves an issue as issues', () => {
    expect(toApiUrl('https://github.com/acme/web/issues/7')).toBe(
      'https://api.github.com/repos/acme/web/issues/7',
    );
  });

  /**
   * Anything unrecognised comes back unchanged, and is then refused by the
   * egress check rather than here. Two places would be one too many: a URL that
   * this quietly rewrote into something GitHub-shaped would pass a check that
   * is supposed to be the last word.
   */
  it('does not invent a GitHub URL out of one that is not', () => {
    for (const url of [
      'https://evil.com/acme/web/pull/42',
      'https://github.com.evil.com/acme/web/pull/42',
      'https://github.com/acme/web/pull/42/extra',
      'not a url',
    ]) {
      expect(toApiUrl(url)).toBe(url);
    }
  });
});

describe('relative time', () => {
  it('reads as English rather than a timestamp', () => {
    const now = Date.now();

    expect(relativeTime(new Date(now - 45_000))).toBe('45 seconds ago');
    expect(relativeTime(new Date(now - 60_000))).toBe('1 minute ago');
    expect(relativeTime(new Date(now - 3 * 86_400_000))).toBe('3 days ago');
  });

  /** A pull request with no `closed_at` yet must not render "Invalid Date". */
  it('says nothing rather than nonsense for a missing date', () => {
    expect(relativeTime(undefined as never)).toBe('');
    expect(relativeTime('not a date')).toBe('');
  });
});
