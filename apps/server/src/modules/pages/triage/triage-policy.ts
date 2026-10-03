/**
 * The policies an entry is held to before anything else is asked of it.
 *
 * All deterministic: a pattern, a count, a lookup. They run first because they
 * are cheap, and because what they catch (a credential, a list of claims, text
 * from outside the workspace) should never reach a model's judgment of whether
 * the entry is true.
 */

export { redactSecrets, SECRET_PATTERNS, secretIn } from '@vantikhq/llm-tasks';

/** Longer than one fact is written in, with its reason. */
export const MAX_ONE_FACT_LENGTH = 1_000;

/**
 * Why the content is more than one claim, or null.
 *
 * One claim per row is what makes an entry something that can be accepted,
 * corrected or retired on its own. A list is several claims that would stand
 * or fall together, and text past a thousand characters is a note, not a
 * fact. Both are refused so the writer splits them; neither is a judgment
 * about whether what they say is true.
 */
export function severalClaimsIn(content: string): string | null {
  const items = (content ?? '')
    .split('\n')
    .filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line));

  if (items.length >= 2) {
    return `it is a list of ${items.length} items; write one entry per item`;
  }

  if ((content ?? '').trim().length > MAX_ONE_FACT_LENGTH) {
    return `it is longer than ${MAX_ONE_FACT_LENGTH} characters; one fact is shorter`;
  }

  return null;
}

/** An issue as the external-input check reads it. */
export interface IssueProvenance {
  sourceMetadata: unknown;
  team?: { preferences: unknown } | null;
  support?: { id: string } | null;
  linkedIssue?: Array<{ sourceData: unknown; sync?: boolean | null }> | null;
  comments?: Array<{ sourceMetadata: unknown }> | null;
}

/**
 * Where an issue's text came from outside the workspace, or null.
 *
 * A run reads its issue, and an issue an integration created, or one synced
 * with a thread outside, carries text anyone outside could have written: the
 * standard route for poisoning an agent's memory. Knowledge from such a run is
 * never accepted without a person. Read broadly on purpose: every way an
 * outside party's text reaches the issue counts, and a pull request link does
 * not, because the pull request is the work.
 */
export function externalSourceOf(issue: IssueProvenance): string | null {
  const metadata = asRecord(issue.sourceMetadata);

  // An integration that files an issue says which it was (`type`); a run
  // handing work back records `source: 'agent-run'`, which is not outside.
  if (typeof metadata.type === 'string' && metadata.type.trim()) {
    return metadata.type;
  }

  if (issue.support) {
    return 'support';
  }

  if (asRecord(issue.team?.preferences).teamType === 'support') {
    return 'support';
  }

  for (const link of issue.linkedIssue ?? []) {
    const data = asRecord(link.sourceData);

    if (data.githubType === 'PR') {
      continue;
    }

    if (typeof data.type === 'string' && data.type.trim()) {
      return data.type;
    }

    // A link that syncs, from whatever source, brings its thread in.
    if (link.sync) {
      return 'linked issue';
    }
  }

  // A comment mirrored from a thread outside stays on the issue after the
  // link is gone, and a run is handed the comments with the issue.
  for (const comment of issue.comments ?? []) {
    const source = commentSourceOf(comment);

    if (source) {
      return source;
    }
  }

  return null;
}

/** Where a comment's text came from outside the workspace, or null. */
export function commentSourceOf(comment: {
  sourceMetadata: unknown;
}): string | null {
  const metadata = asRecord(comment.sourceMetadata);

  return typeof metadata.type === 'string' && metadata.type.trim()
    ? metadata.type
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
