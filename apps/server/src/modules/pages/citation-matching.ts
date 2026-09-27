import { createHash } from 'crypto';

import { PageEntryCitationCheckEnum } from '@vantikhq/types';

/**
 * Telling code that moved from code that changed, by comparing text.
 *
 * No model is asked anything here. A snippet is the cited lines as the server
 * read them at the cited commit, each line trimmed and with its runs of
 * whitespace collapsed, so re-indenting a block or reflowing spaces does not
 * count as a change while any change to a token does. A check then looks for
 * the snippet at the lines it was cited at (it holds), anywhere else in the
 * file (it moved), or nowhere (it changed).
 */

/** The most lines one citation may span. A claim rests on a few lines. */
export const MAX_CITED_LINES = 200;

export interface LineRange {
  start: number;
  end: number;
}

/** "40-52" or "40", 1-based and inclusive, or null if it is neither. */
export function parseLineRange(text: string | undefined): LineRange | null {
  const match = /^\s*(\d{1,7})\s*(?:-\s*(\d{1,7})\s*)?$/.exec(text ?? '');

  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);

  return start >= 1 && end >= start ? { start, end } : null;
}

export function formatLineRange({ start, end }: LineRange): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

/** One line as it is compared: trimmed, with whitespace runs collapsed. */
export function normaliseLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * A file's lines, numbered the way an editor numbers them: the newline ending
 * the last line does not start another one.
 */
export function fileLines(content: string): string[] {
  const lines = content.split(/\r?\n/);

  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

export type SnippetResult =
  | { snippet: string; snippetHash: string }
  | { error: string };

/**
 * The snippet for a range of a file, or why the range cannot be cited.
 *
 * A range past the end of the file is the usual mistake, a line number from a
 * different version of it; the reason says how long the file actually is so
 * the writer can correct it. A range of only blank lines cites nothing.
 */
export function snippetAt(content: string, range: LineRange): SnippetResult {
  if (range.end - range.start + 1 > MAX_CITED_LINES) {
    return {
      error: `cites ${range.end - range.start + 1} lines; cite at most ${MAX_CITED_LINES}, the lines the claim rests on`,
    };
  }

  const lines = fileLines(content);

  if (range.end > lines.length) {
    return {
      error: `the file has ${lines.length} line${lines.length === 1 ? '' : 's'} at that commit, so lines ${formatLineRange(range)} are not there`,
    };
  }

  const cited = lines.slice(range.start - 1, range.end).map(normaliseLine);

  if (cited.every((line) => line === '')) {
    return { error: `lines ${formatLineRange(range)} are blank` };
  }

  const snippet = cited.join('\n');

  return { snippet, snippetHash: hashSnippet(snippet) };
}

export function hashSnippet(snippet: string): string {
  return createHash('sha256').update(snippet).digest('hex');
}

/**
 * Whether text the writer expected is within a snippet.
 *
 * Compared with whitespace collapsed across lines, so a quote copied from an
 * editor matches however it was wrapped.
 */
export function snippetContains(snippet: string, quote: string): boolean {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  const expected = flat(quote);

  return expected.length > 0 && flat(snippet).includes(expected);
}

export interface Relocation {
  result:
    | PageEntryCitationCheckEnum.HOLDS
    | PageEntryCitationCheckEnum.MOVED
    | PageEntryCitationCheckEnum.CHANGED;
  /** Where the snippet is now; the old range when it changed. */
  range: LineRange;
}

/**
 * Where a snippet is in the current version of its file.
 *
 * At the cited lines, it holds. Elsewhere, it moved, and the range becomes the
 * occurrence nearest the old one, since a block that appears twice most likely
 * kept its place relative to the code around it. Nowhere, it changed.
 */
export function relocate(
  snippet: string,
  content: string,
  range: LineRange,
): Relocation {
  const wanted = snippet.split('\n');
  const lines = fileLines(content).map(normaliseLine);
  const matchesAt = (index: number) =>
    wanted.every((line, offset) => lines[index + offset] === line);

  if (
    matchesAt(range.start - 1) &&
    range.end - range.start + 1 === wanted.length
  ) {
    return { result: PageEntryCitationCheckEnum.HOLDS, range };
  }

  let nearest: number | null = null;

  for (let index = 0; index + wanted.length <= lines.length; index++) {
    if (
      matchesAt(index) &&
      (nearest === null ||
        Math.abs(index - (range.start - 1)) <
          Math.abs(nearest - (range.start - 1)))
    ) {
      nearest = index;
    }
  }

  if (nearest === null) {
    return { result: PageEntryCitationCheckEnum.CHANGED, range };
  }

  const start = nearest + 1;
  const moved = { start, end: start + wanted.length - 1 };

  return {
    result:
      moved.start === range.start && moved.end === range.end
        ? PageEntryCitationCheckEnum.HOLDS
        : PageEntryCitationCheckEnum.MOVED,
    range: moved,
  };
}
