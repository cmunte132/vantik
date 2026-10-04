#!/usr/bin/env node
/**
 * This script writes the release notes on the changelog page of the docs,
 * apps/docs/docs/changelog.mdx.
 *
 * The notes for a release are the subjects of the commits after the last
 * release tag. A merge commit and a "Release" commit are not notes. The
 * subjects are prose sentences, so they are good notes as they are.
 *
 * release.mjs calls `addRelease` before it commits a release. To write the
 * notes for a tag that exists, run:
 *
 *   node scripts/changelog.mjs <tag>
 *
 * The page keeps the newest release first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CHANGELOG = "apps/docs/docs/changelog.mdx";

// The script puts each new release immediately below this line.
const MARKER = "{/* release-notes */}";

const CALENDAR_TAG = /^\d{4}\.\d{1,2}\.\d+$/;

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** This function returns the calendar release tags, the oldest first. */
function calendarTags() {
  return git("tag", "--list", "--sort=version:refname")
    .split("\n")
    .filter((tag) => CALENDAR_TAG.test(tag));
}

/**
 * This function returns the release tag before `version`. If `version` is the
 * first calendar release, it returns null.
 */
function previousTag(version) {
  const earlier = calendarTags().filter(
    (tag) => tag !== version && compare(tag, version) < 0,
  );
  return earlier.at(-1) ?? null;
}

function compare(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// MDX reads `<` and `{` as the start of JSX. A backslash makes each one text.
function escape(subject) {
  return subject.replace(/([\\<>{}])/g, "\\$1");
}

/**
 * This function returns the section of the page for one release. `to` is the
 * last commit of the release.
 */
export function section(version, to, date) {
  const from = previousTag(version);
  const range = from ? `${from}..${to}` : to;
  const subjects = git("log", "--no-merges", "--format=%s", range)
    .split("\n")
    .filter((subject) => subject && !/^Release \d/.test(subject));
  const lines = subjects.map((subject) => `- ${escape(subject)}`);
  return [`## ${version}`, "", `Released on ${date}.`, "", ...lines, ""].join(
    "\n",
  );
}

/**
 * This function puts the section for `version` on the page. If the page has a
 * section for `version`, the function replaces it.
 */
export function addRelease(version, to, date) {
  const path = join(ROOT, CHANGELOG);
  const text = readFileSync(path, "utf8");
  const at = text.indexOf(MARKER);
  if (at === -1) throw new Error(`${CHANGELOG} has no ${MARKER} line.`);

  const head = text.slice(0, at + MARKER.length);
  const sections = text
    .slice(at + MARKER.length)
    .split(/\n(?=## )/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith(`## ${version}\n`));
  sections.push(section(version, to, date).trim());
  sections.sort((a, b) => compare(heading(b), heading(a)));
  writeFileSync(path, `${head}\n\n${sections.join("\n\n")}\n`);
}

function heading(part) {
  return part.match(/^## (\S+)/)[1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag || !CALENDAR_TAG.test(tag)) {
    console.error("usage: node scripts/changelog.mjs <YYYY.M.N tag>");
    process.exit(1);
  }
  const date = git("log", "-1", "--format=%as", tag);
  addRelease(tag, tag, date);
  console.log(`Wrote the notes for ${tag} in ${CHANGELOG}.`);
}
