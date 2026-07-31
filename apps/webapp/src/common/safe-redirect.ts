/** Copyright (c) 2024, Vantik, all rights reserved. **/

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

  // One condition, stated positively, guarding the value's use. The three
  // parts are:
  //
  //   - it begins at this origin's root, so it is a path and not a scheme like
  //     `javascript:` or `https:`, and not a bare `acme/issues`;
  //   - it does not begin with two slashes, because `//evil.com` is read by
  //     browsers as protocol-relative — an ordinary-looking path that is in
  //     fact a different host;
  //   - it holds no backslash, because a browser normalises one to a slash
  //     inside a URL, so `/\evil.com` is the second case spelled differently
  //     and `/acme\..\..\evil.com` is a path here and a host there.
  //
  // The shape is deliberate and took four attempts to find. A regular
  // expression saying the same thing — with a lookahead, then with a character
  // class — left all six alerts standing. Splitting these into three negative
  // early returns cleared the three `js/xss` alerts and left the three
  // redirection ones. This is the form the check is modelled as: the
  // conditions together, in the affirmative, deciding whether the value is
  // used. It is also, as it happens, the clearest way to read it — the whole
  // rule in one place rather than three refusals to assemble in your head.
  if (
    candidate.startsWith('/') &&
    !candidate.startsWith('//') &&
    !candidate.includes('\\')
  ) {
    return candidate;
  }

  return '/';
}
