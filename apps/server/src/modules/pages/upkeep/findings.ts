import { createHash } from 'crypto';

import {
  pathBelongsToModule,
  type RepoModuleMapping,
} from 'modules/modules/module-routing';

/**
 * How reviewer findings are compared and grouped, with no model involved.
 *
 * Two findings are the same finding when their words mostly agree: the share
 * of words they have in common (Jaccard) is at least `SAME_FINDING`. Words
 * are the message lower-cased, split on everything that is not a letter,
 * digit or underscore, without the common words and without numbers, which
 * are line numbers and counts more often than they are what a finding is
 * about. Deterministic, so a group is the same group however often it is
 * read, and cheap enough to run at the end of every run.
 */

/**
 * The share of words two findings must have in common to be the same
 * finding. Half: "Use the logger, not console.log" and "console.log used
 * instead of the logger" agree, "Missing test for the cache" does not.
 */
export const SAME_FINDING = 0.5;

/** Words that say nothing about what a finding is about. */
const COMMON_WORDS = new Set([
  'about',
  'also',
  'and',
  'any',
  'are',
  'been',
  'being',
  'but',
  'can',
  'could',
  'did',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'here',
  'how',
  'into',
  'its',
  'just',
  'may',
  'more',
  'most',
  'must',
  'not',
  'now',
  'off',
  'one',
  'only',
  'other',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'too',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** A finding as grouping reads it. */
export interface GroupedFinding {
  id: string;
  agentRunId: string;
  words: string[];
  createdAt: Date;
}

/** The words a finding is compared by, each once, first mention first. */
export function findingWords(message: string): string[] {
  const words = (message ?? '').toLowerCase().match(/[a-z0-9_]+/g) ?? [];

  return [
    ...new Set(
      words.filter(
        (word) =>
          word.length > 2 && !/^\d+$/.test(word) && !COMMON_WORDS.has(word),
      ),
    ),
  ];
}

/**
 * What makes a finding one finding within a run: its module and its words,
 * in any order. A reviewer repeating itself across a run's passes, or in two
 * findings on one pass, is one finding, not two runs' worth of evidence.
 */
export function findingKey(moduleId: string, words: string[]): string {
  return createHash('sha256')
    .update(`${moduleId}\n${[...words].sort().join(' ')}`)
    .digest('hex');
}

/** The share of words two findings have in common, from 0 to 1. */
export function likeness(
  left: readonly string[],
  right: readonly string[],
): number {
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;

  for (const word of a) {
    if (b.has(word)) {
      shared++;
    }
  }

  const all = a.size + b.size - shared;

  return all === 0 ? 0 : shared / all;
}

/**
 * Findings grouped into the same finding, oldest first. Each joins the
 * first group whose first finding it is like, or starts a group. Compared
 * with a group's first finding, not with any member, so a group cannot
 * drift one small step at a time into findings about something else.
 */
export function groupFindings<T extends GroupedFinding>(findings: T[]): T[][] {
  const ordered = [...findings].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const groups: T[][] = [];

  for (const finding of ordered) {
    const group = groups.find(
      (candidate) =>
        likeness(candidate[0].words, finding.words) >= SAME_FINDING,
    );

    if (group) {
      group.push(finding);
    } else {
      groups.push([finding]);
    }
  }

  return groups;
}

/** How many separate runs gave a group's finding. */
export function distinctRuns(group: GroupedFinding[]): number {
  return new Set(group.map((finding) => finding.agentRunId)).size;
}

/**
 * The finding that best stands for its group: the one most like the others,
 * the oldest of those equally so.
 */
export function representative<T extends GroupedFinding>(group: T[]): T {
  let best = group[0];
  let bestScore = -1;

  for (const finding of group) {
    const score = group.reduce(
      (sum, other) =>
        other === finding ? sum : sum + likeness(finding.words, other.words),
      0,
    );

    if (score > bestScore) {
      best = finding;
      bestScore = score;
    }
  }

  return best;
}

/**
 * The module a file belongs to, of those a repository's mappings name: the
 * one whose folder holding it is deepest, so a file in a module nested in
 * another is the inner module's. A module that is the whole repository
 * holds every file, least deeply. The first mapping wins a tie; null when
 * none holds it.
 */
export function moduleOfPath(
  mappings: RepoModuleMapping[],
  path: string,
): string | null {
  let found: { moduleId: string; depth: number } | null = null;

  for (const mapping of mappings) {
    const prefixes = mapping.pathPrefixes.length ? mapping.pathPrefixes : [''];

    for (const prefix of prefixes) {
      if (!pathBelongsToModule(path, prefix ? [prefix] : [])) {
        continue;
      }

      const depth = prefix.replace(/^\/+|\/+$/g, '').length;

      if (!found || depth > found.depth) {
        found = { moduleId: mapping.moduleId, depth };
      }
    }
  }

  return found?.moduleId ?? null;
}

/** The line a piece of evidence gives for a path (`src/a.ts:42`), or null. */
export function lineOf(evidence: string, path: string): number | null {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:(\\d+)`).exec(evidence ?? '');
  const line = match ? Number(match[1]) : NaN;

  return Number.isInteger(line) && line > 0 ? line : null;
}
