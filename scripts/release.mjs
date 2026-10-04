#!/usr/bin/env node
/**
 * Cut a Vantik release: `pnpm release`, or `pnpm release --dry-run` to see
 * what it would do.
 *
 * Vantik is versioned by the calendar, YYYY.M.N: the year, the month without a
 * leading zero, and a count of the releases made in that month, from 0. So the
 * first release in September 2026 is 2026.9.0 and the next is 2026.9.1. The
 * month has no leading zero because semver forbids one, and npm, pnpm and the
 * image tooling all read these strings as semver.
 *
 * Everything moves together: the server, the webapp, the images and the
 * published packages carry one number. This script is the only thing that
 * writes it. It sets the version in every file below, adds the release notes
 * to the docs changelog, commits, and makes an annotated tag. It does not
 * push; pushing the tag is the release, because the tag is what builds the
 * images.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHANGELOG, addRelease } from "./changelog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = [
  "package.json",
  "apps/server/package.json",
  "apps/webapp/package.json",
  "packages/agent-core/package.json",
  "packages/cli/package.json",
  "packages/types/package.json",
];

// The API reference shows the version too. The .mdx is generated from the
// .yml, but it is committed, so both are set here. Each pattern has two
// groups, the text before the version and the text after it.
const DOCS = [
  { file: "apps/docs/openapi/openapi.yml", pattern: /^(  version: ).+()$/m },
  {
    file: "apps/docs/docs/api-reference/vantik.info.mdx",
    pattern: /("Version: )[^"]+(")/,
  },
];

const dryRun = process.argv.includes("--dry-run");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

if (!dryRun && git("status", "--porcelain")) {
  fail("the working tree has changes. Commit or stash them first.");
}

// Best effort: a release made on another machine this month must count, but
// being offline should not stop a release.
try {
  git("fetch", "--tags", "--quiet");
} catch {
  console.warn("release: could not fetch tags; counting local tags only.");
}

const now = new Date();
const month = `${now.getFullYear()}.${now.getMonth() + 1}`;
const released = git("tag", "--list", `${month}.*`)
  .split("\n")
  .map((tag) => tag.match(/^\d+\.\d+\.(\d+)$/)?.[1])
  .filter(Boolean)
  .map(Number);
const version = `${month}.${released.length ? Math.max(...released) + 1 : 0}`;

const changed = [];

for (const file of PACKAGES) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  // A replacement, not a JSON round trip, so the file keeps its formatting.
  const next = text.replace(/("version": ")[^"]+(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    fail(`${file} has no "version" field.`);
  }
  changed.push(file);
  if (!dryRun) writeFileSync(path, next);
}

for (const { file, pattern } of DOCS) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) {
    fail(`${file} has no version line.`);
  }
  changed.push(file);
  if (!dryRun) {
    writeFileSync(path, text.replace(pattern, `$1${version}$2`));
  }
}

// The notes are the commits since the last release. See changelog.mjs.
changed.push(CHANGELOG);
if (!dryRun) {
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  addRelease(version, "HEAD", today);
}

if (dryRun) {
  console.log(`Would release ${version}, setting it in:`);
  for (const file of changed) console.log(`  ${file}`);
  process.exit(0);
}

git("add", ...changed);
git("commit", "--quiet", "-m", `Release ${version}`);
git("tag", "--annotate", version, "--message", `Vantik ${version}`);

console.log(`Released ${version} and tagged it. To publish it:

  git push origin HEAD ${version}

The tag push builds and publishes the images, retakes the docs screenshots,
and publishes the npm packages (see .github/workflows/publish-packages.yml).`);
