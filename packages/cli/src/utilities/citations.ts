import { VantikError, type CitationInput } from '@vantikhq/agent-core';

/**
 * A citation as typed at a terminal.
 *
 *   apps/server/src/main.ts:40-52          lines at the default branch head
 *   apps/server/src/main.ts:40@1a2b3c4     one line, at a commit
 *   issue:ENG-42   pr:<url>   comment:<id>   run:<id>
 *   '{"path": "...", "lines": "...", "repo": "owner/name", "quote": "..."}'
 *
 * The JSON form takes every field the API does, for the cases the shorthand
 * cannot say (naming a repository, quoting the lines). What the citation says
 * is checked by the server; this only reads it.
 */
export function parseCitation(value: string): CitationInput {
  const text = value.trim();

  if (text.startsWith('{')) {
    try {
      return JSON.parse(text) as CitationInput;
    } catch {
      throw new VantikError(`Citation ${text} is not valid JSON.`);
    }
  }

  const target = /^(issue|pr|comment|run):(.+)$/i.exec(text);

  if (target) {
    const key = (target[1] ?? '').toLowerCase();
    const reference = target[2] ?? '';

    return key === 'issue'
      ? { issue: reference }
      : key === 'pr'
        ? { pullRequest: reference }
        : key === 'comment'
          ? { comment: reference }
          : { run: reference };
  }

  const code = /^(.+):(\d+(?:-\d+)?)(?:@([0-9a-f]{7,40}))?$/i.exec(text);

  if (code) {
    const sha = code[3];

    return {
      path: code[1] ?? '',
      lines: code[2] ?? '',
      ...(sha ? { sha } : {}),
    };
  }

  throw new VantikError(
    `Cannot read citation "${value}". Cite code as path:40-52 (optionally ` +
      '@<commit>), or issue:ENG-42, pr:<url>, comment:<id> or run:<id>.',
  );
}

/** Commander's collector for a repeatable `--cite`. */
export function collectCitation(
  value: string,
  previous: CitationInput[] = [],
): CitationInput[] {
  return [...previous, parseCitation(value)];
}
