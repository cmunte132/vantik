/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * What a workspace slug is allowed to contain.
 *
 * A slug is generated, not typed: letters, digits and dashes. So the answer to
 * a value that is not one is to refuse it, not to encode it. Encoding would
 * make `/evil.com` into a harmless-looking `%2Fevil.com` segment and send the
 * person to a workspace page that cannot exist; refusing sends them to the app
 * root, which is where somebody with no workspace belongs.
 *
 * Refusing is also the stronger statement. An encoder has to be right about
 * every character that could change what a URL means. A list of the characters
 * a slug may contain has to be right about the slug.
 */
const SAFE_SLUG = /^[A-Za-z0-9_-]+$/;

/**
 * Builds a path inside a workspace from parts that came out of the URL.
 *
 * Almost every navigation in the app is a template literal starting
 * `/${workspaceSlug}/`, where the slug is read straight back off the router.
 * That is a value the person browsing controls, and two things go wrong if it
 * is dropped into a path unexamined.
 *
 * The first is that a slug holding a slash changes what the path means rather
 * than what it says. A slug that decodes to an empty string leaves `//rest`,
 * which a browser reads as protocol-relative and sends to a host called `rest`
 * — an ordinary relative link that quietly leaves the origin. A slug that
 * decodes with a leading slash does the same thing with a host of somebody
 * else's choosing.
 *
 * The second is that every one of these call sites is a separate finding for a
 * scanner reading the app, because each one is its own flow from a router value
 * into a navigation. One helper is one place to look at, and one place to
 * change.
 *
 * Each part is encoded, so a name with a space or a slash in it lands in the
 * URL as a single segment instead of splitting into two.
 */
export function workspaceHref(
  workspaceSlug: string | string[] | undefined,
  ...parts: Array<string | number | undefined | null>
): string {
  const raw = Array.isArray(workspaceSlug) ? workspaceSlug[0] : workspaceSlug;
  const candidate = typeof raw === 'string' ? raw.trim() : '';

  // Tested here rather than inside a helper. This is the check that decides
  // whether a value out of the URL is allowed to become part of a destination,
  // and putting it behind a function call hides it from a reader and from an
  // analyser tracing where a router value can reach.
  const slug = SAFE_SLUG.test(candidate) ? candidate : '';

  // With no slug there is no workspace path to build. The app root is where a
  // person with no workspace belongs, and it is a destination on this origin,
  // which `/${undefined}/...` is not.
  if (!slug) {
    return '/';
  }

  const rest = parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => encodeURIComponent(String(part)));

  return `/${[slug, ...rest].join('/')}`;
}
