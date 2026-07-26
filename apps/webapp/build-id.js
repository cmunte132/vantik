/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * The build stamp: one identity for "which build is this".
 *
 * It is used three ways, and they have to agree:
 *
 *   - as Next's `generateBuildId`, so the chunk namespace under
 *     /_next/static/<buildId>/ *is* the version;
 *   - inlined into the client bundle, so a running client knows which build it
 *     is;
 *   - served from /api/version, so a client can ask what the server is serving
 *     now.
 *
 * Determinism matters as much as uniqueness. With Next's default random build
 * id, rebuilding unchanged source moves every chunk URL and breaks clients
 * that are already open, for no reason. Deriving the id from the commit means
 * an unchanged rebuild produces the same URLs and nobody is forced to reload.
 */

const { execSync } = require('child_process');

/**
 * Build ids land in URLs and on disk, so anything outside this set is folded
 * to a dash rather than trusted.
 */
function sanitize(value) {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 64);
}

/**
 * `.git` is in .dockerignore, so an image build genuinely cannot read the
 * commit — it arrives as VANTIK_BUILD_ID instead (see apps/webapp/Dockerfile).
 * This path is what makes host builds work without any configuration.
 */
function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

let resolved;

function resolveBuildStamp() {
  if (resolved) {
    return resolved;
  }

  // Development is deliberately a fixed value. A stamp that moved on every
  // recompile would have the update indicator fighting HMR all day.
  if (process.env.NODE_ENV !== 'production') {
    resolved = { buildId: 'dev', commit: 'dev', builtAt: null };
    return resolved;
  }

  const commit = process.env.VANTIK_COMMIT || gitCommit();

  // In descending order of how specific the source is. The explicit override is
  // first because it is how the commit reaches an image build at all.
  //
  // Note the version tier carries a timestamp and the commit tiers do not. Two
  // builds of the same commit *should* share an id — that is what stops an
  // unchanged rebuild from evicting open clients. But VERSION is bumped per
  // release, not per build, so on its own it would give two genuinely different
  // builds the same id, and a colliding id is far worse than a churning one: the
  // client cannot tell it is stale, and its cached chunk URLs now point at
  // different content. Where we cannot identify the source, uniqueness wins.
  const version = process.env.VERSION || process.env.NEXT_PUBLIC_VERSION;

  const buildId =
    process.env.VANTIK_BUILD_ID ||
    commit ||
    (version ? `${version}-${Date.now()}` : `build-${Date.now()}`);

  resolved = {
    buildId: sanitize(buildId),
    commit: commit ? sanitize(commit) : 'unknown',
    builtAt: new Date().toISOString(),
  };

  return resolved;
}

module.exports = { resolveBuildStamp };
