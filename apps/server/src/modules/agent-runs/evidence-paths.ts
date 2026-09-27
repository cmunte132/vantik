/**
 * The repository files a piece of evidence names.
 *
 * A review finding points at `src/thing.ts:42` or at a command in backticks,
 * and a failing check prints the files it failed in. Both are how a run's
 * outcome is traced to the knowledge it was handed: a finding in a file an
 * entry cites, or under its scope, says something about that entry.
 *
 * Deliberately liberal. A word that only looks like a path (`e.g`) is taken
 * too, and costs nothing: an entry is only touched when a path equals a file
 * it cites or falls under the folder its scope names, and nothing that is not
 * a file in the repository does either.
 */

/** Where the repository is checked out inside a hosted sandbox. */
const SANDBOX_REPO = '/workspace/repo/';

/** More than any real report names, few enough to keep in a row. */
export const MAX_EVIDENCE_PATHS = 50;

/**
 * How much of a piece of evidence is read. A check's output is its tail and
 * already shorter; a finding's evidence is a sentence or two.
 */
export const MAX_EVIDENCE_TEXT = 16_000;

/** Longer than any path in a repository; a longer run is not one. */
const MAX_PATH_LENGTH = 512;

/** What a path is made of. Everything else separates one from the next. */
const NOT_PATH = /[^\w@+./-]+/;

/**
 * Folders, then a file with a letter-led extension (`ci.yml`, `.eslintrc.json`)
 * or a dotfile (`.env`); any segment may start with a dot, as `.github` does.
 * A `:line` or `:line:column` after it is left out of the match. A file with
 * no extension at all (`Makefile`) is not told apart from a word, and is not
 * read.
 */
const PATH =
  /(?:\.{0,2}\/)*(?:\.?[\w@+-][\w@+.-]*\/)*(?:\.?[\w@+-][\w@+.-]*\.[A-Za-z][\w-]*|\.[A-Za-z][\w-]*)/g;

/**
 * The repository-relative paths in some text, first mention first.
 *
 * The text is split into runs of path characters first, and the pattern only
 * looks inside a run of a path's length. Every path lies inside one run, so
 * nothing is lost; what is gained is that the pattern, which backtracks, never
 * works over a long stretch of output with no path in it.
 */
export function evidencePaths(text: string | null | undefined): string[] {
  const found = new Set<string>();

  for (const run of (text ?? '').slice(0, MAX_EVIDENCE_TEXT).split(NOT_PATH)) {
    if (run.length > MAX_PATH_LENGTH) {
      continue;
    }

    for (const match of run.matchAll(PATH)) {
      const path = repoRelative(match[0]);

      if (path) {
        found.add(path);
      }

      if (found.size >= MAX_EVIDENCE_PATHS) {
        return [...found];
      }
    }
  }

  return [...found];
}

function repoRelative(raw: string): string | null {
  let path = raw;

  if (path.startsWith(SANDBOX_REPO)) {
    path = path.slice(SANDBOX_REPO.length);
  } else if (path.startsWith('/')) {
    // Absolute, and not in the checkout: a system file or a package in a
    // cache, which no entry cites.
    return null;
  }

  path = path.replace(/^(\.\/)+/, '');

  return path && !path.startsWith('../') ? path : null;
}
