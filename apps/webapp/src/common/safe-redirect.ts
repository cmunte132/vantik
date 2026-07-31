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

  // Written as `startsWith` rather than as one regular expression, and spelled
  // out step by step, because this is the form a scanner recognises as a check
  // that a URL is local. Two earlier versions of this file said exactly the
  // same thing with a regular expression — first with a negative lookahead,
  // then with a character class — and both left all six alerts standing on
  // main while being just as correct. The condition a person needs and the
  // condition a tool can follow happen to be the same one here, so it is
  // written the way the tool reads it.

  // A destination on this origin begins at its root. Anything else — a scheme
  // like `javascript:` or `https:`, or a bare `acme/issues` — is not a path,
  // and is refused before any other question is asked.
  if (!candidate.startsWith('/')) {
    return '/';
  }

  // The one that matters. `//evil.com` is read by browsers as
  // protocol-relative: an ordinary-looking path that is in fact a different
  // host. It leaves the origin while passing every test that only asks for a
  // leading slash.
  if (candidate.startsWith('//')) {
    return '/';
  }

  // The same attack spelled with the other separator. A browser normalises a
  // backslash to a slash inside a URL, so `/\evil.com` is `//evil.com`, and a
  // backslash further along does the same work: `/acme\..\..\evil.com` reads
  // as a path here and navigates as a host there.
  if (candidate.includes('\\')) {
    return '/';
  }

  return candidate;
}
