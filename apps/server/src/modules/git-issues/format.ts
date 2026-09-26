/**
 * The file format of the issue mirror, shared by the half that writes it and
 * the half that reads an agent's edits back.
 *
 * Front matter is `key: value` lines with a blank line between each pair. The
 * blank lines are there for git rather than for a reader: two edits to
 * adjacent lines are one conflicting hunk to a three-way merge, while two edits
 * separated by an unchanged line merge cleanly. An agent that rebases its
 * proposal onto a newer snapshot therefore only conflicts where it touched the
 * same field as somebody else.
 *
 * Strings are written as JSON so that a title with a colon or a quote in it
 * survives, and read back leniently, because the thing editing them is a model
 * that will sometimes drop the quotes.
 */

export const PRIORITY_NAMES = ['none', 'urgent', 'high', 'medium', 'low'];

export function priorityName(priority: number | null | undefined): string {
  return PRIORITY_NAMES[priority ?? 0] ?? 'none';
}

/** 0 to 4 from a name or a digit, or null when it is neither. */
export function parsePriority(value: string): number | null {
  const normalised = value.trim().toLowerCase();
  const byName = PRIORITY_NAMES.indexOf(normalised);

  if (byName !== -1) {
    return byName;
  }

  return /^[0-4]$/.test(normalised) ? Number(normalised) : null;
}

export type FrontMatterValue = string | string[] | null | undefined;

/** Fields in the order given; a null or undefined value is left out. */
export function renderFrontMatter(
  fields: Array<[string, FrontMatterValue]>,
  body: string,
): string {
  const lines = fields
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) =>
      Array.isArray(value)
        ? `${key}: ${JSON.stringify(value)}`
        : `${key}: ${value}`,
    );

  const trimmed = body.trim();

  return ['---', lines.join('\n\n'), '---', '', trimmed, ''].join('\n');
}

export function quoted(value: string): string {
  return JSON.stringify(value);
}

export interface ParsedFile {
  fields: Record<string, string>;
  body: string;
}

/** Null when the text does not open with a front matter block. */
export function parseFrontMatter(text: string): ParsedFile | null {
  const normalised = text.replace(/\r\n/g, '\n');
  // The closing fence has to start a line, so a title with `---` in it does
  // not end the block early.
  const match = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(normalised);

  if (!match) {
    return null;
  }

  const fields: Record<string, string> = {};

  for (const line of (match[1] ?? '').split('\n')) {
    const separator = line.indexOf(':');

    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();

    if (key) {
      fields[key] = line.slice(separator + 1).trim();
    }
  }

  return { fields, body: normalised.slice(match[0].length).trim() };
}

export function readString(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : raw;
    } catch {
      return raw.replace(/^"|"$/g, '');
    }
  }

  return raw;
}

/** `["a", "b"]`, or the same without the quotes, or a bare `a, b`. */
export function readList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    // Not JSON; read it as a plain list below.
  }

  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) =>
      item
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim(),
    )
    .filter(Boolean);
}

/** A git-safe name for a comment file: sortable by time, unique by id. */
export function commentFilename(createdAt: Date, commentId: string): string {
  const stamp = createdAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

  return `${stamp}--${commentId}.md`;
}
