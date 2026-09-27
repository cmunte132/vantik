/**
 * Telling moved code from changed code by comparing text, with no model.
 */
import { PageEntryCitationCheckEnum } from '@vantikhq/types';

import {
  fileLines,
  hashSnippet,
  MAX_CITED_LINES,
  parseLineRange,
  relocate,
  snippetAt,
  snippetContains,
} from './citation-matching';

const FILE = [
  'export function add(a, b) {', // 1
  '  return a + b;', // 2
  '}', // 3
  '', // 4
  'export function sub(a, b) {', // 5
  '  return a - b;', // 6
  '}', // 7
  '',
].join('\n');

function cite(content: string, lines: string) {
  const result = snippetAt(content, parseLineRange(lines));
  if ('error' in result) {
    throw new Error(result.error);
  }
  return result.snippet;
}

describe('line ranges', () => {
  it('[KG-2.2] reads "40-52" and "40", and nothing else', () => {
    expect(parseLineRange('40-52')).toEqual({ start: 40, end: 52 });
    expect(parseLineRange('40')).toEqual({ start: 40, end: 40 });
    expect(parseLineRange(' 3 - 7 ')).toEqual({ start: 3, end: 7 });
    expect(parseLineRange('52-40')).toBeNull();
    expect(parseLineRange('0')).toBeNull();
    expect(parseLineRange('40,52')).toBeNull();
    expect(parseLineRange(undefined)).toBeNull();
  });

  it('numbers lines as an editor does, whatever the line endings', () => {
    expect(fileLines('a\nb\n')).toEqual(['a', 'b']);
    expect(fileLines('a\r\nb')).toEqual(['a', 'b']);
    expect(fileLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('the snippet a citation records', () => {
  it('[KG-2.2] is the cited lines, whitespace-normalised, with their hash', () => {
    const result = snippetAt(FILE, { start: 5, end: 6 });

    expect(result).toEqual({
      snippet: 'export function sub(a, b) {\nreturn a - b;',
      snippetHash: hashSnippet('export function sub(a, b) {\nreturn a - b;'),
    });
  });

  it('[KG-2.2] refuses lines past the end of the file, saying how long it is', () => {
    expect(snippetAt(FILE, { start: 6, end: 9 })).toEqual({
      error: 'the file has 7 lines at that commit, so lines 6-9 are not there',
    });
  });

  it('[KG-2.2] refuses blank lines and ranges longer than a claim rests on', () => {
    expect(snippetAt(FILE, { start: 4, end: 4 })).toEqual({
      error: 'lines 4 are blank',
    });
    expect(snippetAt(FILE, { start: 1, end: MAX_CITED_LINES + 1 })).toEqual({
      error: expect.stringContaining(`cite at most ${MAX_CITED_LINES}`),
    });
  });

  it('[KG-2.2] finds a quote however it was wrapped, and nothing that is not there', () => {
    const snippet = cite(FILE, '1-3');

    expect(snippetContains(snippet, 'return   a +\n b')).toBe(true);
    expect(snippetContains(snippet, 'a - b')).toBe(false);
    expect(snippetContains(snippet, '   ')).toBe(false);
  });
});

describe('relocating a cited snippet in the current code', () => {
  const snippet = cite(FILE, '5-7');

  it('[KG-2.4] holds when the snippet is still at the cited lines', () => {
    expect(relocate(snippet, FILE, { start: 5, end: 7 })).toEqual({
      result: PageEntryCitationCheckEnum.HOLDS,
      range: { start: 5, end: 7 },
    });
  });

  it('[KG-2.4] holds through re-indenting and reflowed spaces', () => {
    const reindented = FILE.replace('  return a - b;', '\t\treturn  a - b;');

    expect(relocate(snippet, reindented, { start: 5, end: 7 }).result).toBe(
      PageEntryCitationCheckEnum.HOLDS,
    );
  });

  it('[KG-2.4] moved when the snippet is elsewhere, with the range updated', () => {
    const shifted = `// header\n// more header\n${FILE}`;

    expect(relocate(snippet, shifted, { start: 5, end: 7 })).toEqual({
      result: PageEntryCitationCheckEnum.MOVED,
      range: { start: 7, end: 9 },
    });
  });

  it('[KG-2.4] moves to the occurrence nearest the old lines when there are several', () => {
    const twice = [
      'export function sub(a, b) {',
      'return a - b;',
      '}',
      ...Array(20).fill('// filler'),
      'export function sub(a, b) {',
      'return a - b;',
      '}',
    ].join('\n');

    expect(relocate(snippet, twice, { start: 20, end: 22 }).range).toEqual({
      start: 24,
      end: 26,
    });
  });

  it('[KG-2.4] changed when the snippet is nowhere in the file', () => {
    const edited = FILE.replace('return a - b;', 'return b - a;');

    expect(relocate(snippet, edited, { start: 5, end: 7 })).toEqual({
      result: PageEntryCitationCheckEnum.CHANGED,
      range: { start: 5, end: 7 },
    });
  });

  it('[KG-2.4] changed when only part of the snippet survives', () => {
    const truncated = FILE.split('\n').slice(0, 6).join('\n');

    expect(relocate(snippet, truncated, { start: 5, end: 7 }).result).toBe(
      PageEntryCitationCheckEnum.CHANGED,
    );
  });
});
