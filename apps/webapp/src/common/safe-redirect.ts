/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * What a place to go back to after signing in is allowed to look like.
 *
 * One leading slash, and the character after it is neither a slash nor a
 * backslash. That second condition is the whole point: `//evil.com` and
 * `/\evil.com` are both read by browsers as protocol-relative, so they leave
 * the origin while looking like ordinary in-app paths. A backslash anywhere
 * else is refused for the same reason — browsers normalise it to a slash in a
 * URL, so a value that reads as one path can navigate as another.
 *
 * A scheme cannot survive this: `javascript:` and `https:` have no leading
 * slash, so they never match.
 *
 * The expression is anchored and has no nested repetition, so it cannot be
 * made to backtrack by a long value.
 */
const SAFE_REDIRECT = /^\/(?![/\\])[^\\]*$/;

/**
 * The path to send somebody to once they are signed in.
 *
 * `redirectToPath` is the query parameter SuperTokens adds when it sends a
 * signed-out person to the sign-in page, so that the thing they were trying to
 * open is what they land on afterwards. It arrives on the URL, which means the
 * person browsing chooses it, and so can anybody who gets them to open a link.
 *
 * Handed to `router.replace` unexamined it is an open redirect: a sign-in page
 * on this origin, with this app's branding, that hands the person to somebody
 * else's site at the moment they have just proved who they are. That is a
 * phishing primitive rather than a cosmetic problem. With a `javascript:` value
 * it stops being a redirect at all and becomes script running on this origin,
 * which is what the scanner reports it as.
 *
 * Anything that is not plainly a path on this origin is refused rather than
 * repaired, and refusing means the app root — the same answer, and the same
 * reasoning, as [[workspaceHref]] gives for a slug it does not recognise.
 */
export function safeRedirectPath(
  value: string | string[] | undefined | null,
): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const candidate = typeof raw === 'string' ? raw.trim() : '';

  // Tested here rather than behind a further call, for the reason
  // `workspace-href` gives: this is the check that decides whether a value out
  // of the URL may become a destination, and it should be visible both to
  // somebody reading the file and to an analyser tracing where it can reach.
  return SAFE_REDIRECT.test(candidate) ? candidate : '/';
}
