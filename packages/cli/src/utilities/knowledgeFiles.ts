import type { KnowledgeEntry, KnowledgePage } from '@vantikhq/agent-core';

/**
 * The on-disk form of the knowledge bank.
 *
 * This is the half of the premise MCP alone does not cover: an agent whose
 * harness has no MCP support, or that reads project instructions from a file,
 * should still get the workspace's knowledge — and knowledge a human writes
 * into a local file should be able to flow back rather than dying in one
 * checkout.
 *
 * **Everything parsed out of these files is data, not instructions.** A pulled
 * file contains prose written by agents in other sessions, in other harnesses.
 * Push reads it, diffs it and uploads it; nothing here interprets it, and
 * nothing downstream should either.
 */

const ENTRIES_OPEN = '<!-- vantik:entries -->';
const ENTRIES_CLOSE = '<!-- /vantik:entries -->';

export interface PageFile {
  pageId: string;
  title: string;
  /** The page's `updatedAt` at pull time — what makes a push safe. */
  revision: string;
  syncedAt: string;
  body: string;
  /** Entries already in the bank, by id. */
  existing: Array<{ id: string; scope: string | null; content: string }>;
  /** Lines added under the entries section that carry no id yet. */
  added: Array<{ scope: string | null; content: string }>;
}

/** A safe, stable filename for a page. */
export function pageFilename(page: { id: string; title: string }): string {
  const slug =
    page.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'page';

  // The id is part of the name so renaming a page in the app does not orphan
  // the file, and so two pages that slug identically do not overwrite each
  // other.
  return `${slug}--${page.id}.md`;
}

export function renderPageFile(page: KnowledgePage, syncedAt: Date): string {
  const frontMatter = [
    '---',
    `vantik-page: ${page.id}`,
    `title: ${JSON.stringify(page.title)}`,
    `revision: ${page.updatedAt}`,
    `synced: ${syncedAt.toISOString()}`,
    '---',
  ].join('\n');

  const entries = page.standing
    .map((entry) => renderEntryLine(entry))
    .join('\n');

  return [
    frontMatter,
    '',
    page.body.trim(),
    '',
    ENTRIES_OPEN,
    '<!-- Facts served to agents. Edit the text to correct one; add a new bullet',
    '     to assert something new. Lines keep their [id] so the push knows which',
    '     is which — do not invent ids. -->',
    entries,
    ENTRIES_CLOSE,
    '',
  ].join('\n');
}

function renderEntryLine(entry: KnowledgeEntry): string {
  const scope = entry.scope ? ` (${entry.scope})` : '';
  // Content is single-line on disk. An entry is one claim; if it needed
  // paragraphs it was never an entry, it was a page.
  const content = entry.content.replace(/\s*\n\s*/g, ' ').trim();

  return `- [${entry.id}]${scope} ${content}`;
}

/** Parses a pulled file back. Returns null when it was not one of ours. */
export function parsePageFile(text: string): PageFile | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);

  if (!match) {
    return null;
  }

  const frontMatter = Object.fromEntries(
    (match[1] ?? '')
      .split('\n')
      .map((line) => {
        const separator = line.indexOf(':');
        return separator === -1
          ? null
          : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
      .filter(Boolean) as Array<[string, string]>,
  );

  if (!frontMatter['vantik-page']) {
    return null;
  }

  const rest = text.slice(match[0].length);
  const open = rest.indexOf(ENTRIES_OPEN);
  const close = rest.indexOf(ENTRIES_CLOSE);

  const body = (open === -1 ? rest : rest.slice(0, open)).trim();
  const entryBlock =
    open === -1 || close === -1
      ? ''
      : rest.slice(open + ENTRIES_OPEN.length, close);

  const existing: PageFile['existing'] = [];
  const added: PageFile['added'] = [];

  for (const raw of entryBlock.split('\n')) {
    const line = raw.trim();

    if (!line.startsWith('- ') || line.startsWith('<!--')) {
      continue;
    }

    const withId = /^- \[([0-9a-f-]{36})\](?:\s*\(([^)]*)\))?\s*(.*)$/i.exec(
      line,
    );

    if (withId) {
      existing.push({
        id: withId[1] as string,
        scope: withId[2]?.trim() || null,
        content: (withId[3] ?? '').trim(),
      });
      continue;
    }

    const bare = /^-\s*(?:\(([^)]*)\))?\s*(.*)$/.exec(line);
    const bareContent = bare?.[2]?.trim();

    if (bareContent) {
      added.push({ scope: bare?.[1]?.trim() || null, content: bareContent });
    }
  }

  return {
    pageId: frontMatter['vantik-page'],
    title: unquote(frontMatter.title ?? ''),
    revision: frontMatter.revision ?? '',
    syncedAt: frontMatter.synced ?? '',
    body,
    existing,
    added,
  };
}

function unquote(value: string): string {
  try {
    return value.startsWith('"') ? (JSON.parse(value) as string) : value;
  } catch {
    return value;
  }
}

const BLOCK_OPEN = '<!-- vantik:knowledge -->';
const BLOCK_CLOSE = '<!-- /vantik:knowledge -->';

/**
 * Writes a managed block into a harness instruction file, leaving everything
 * around it alone.
 *
 * A generated file is a snapshot, not the bank — it goes stale the moment
 * someone edits a page, and a stale file that reads as authoritative is worse
 * than no file. So the block stamps what it was generated from and when, and
 * says plainly that it is a copy.
 */
export function renderManagedBlock(
  items: Array<{ pageTitle: string; content: string; scope: string | null }>,
  scope: string,
  generatedAt: Date,
): string {
  const lines = items.map((item) => {
    const where = item.scope ? ` _(${item.scope})_` : '';
    return `- **${item.pageTitle}**${where} — ${item.content.replace(/\s*\n\s*/g, ' ')}`;
  });

  return [
    BLOCK_OPEN,
    `<!-- Generated from the Vantik knowledge bank, scope: ${scope}.`,
    `     Generated ${generatedAt.toISOString()}. This is a snapshot: the bank`,
    '     is the source of truth and this file goes stale the moment a page',
    '     changes. Re-run `vantik-cli knowledge generate` to refresh it. -->',
    '',
    '## What this workspace knows',
    '',
    ...lines,
    '',
    BLOCK_CLOSE,
  ].join('\n');
}

export function replaceManagedBlock(existing: string, block: string): string {
  const open = existing.indexOf(BLOCK_OPEN);
  const close = existing.indexOf(BLOCK_CLOSE);

  if (open === -1 || close === -1) {
    // Appended rather than written over: whatever the file already said is
    // hand-written, and regeneration must not eat it.
    return `${existing.trimEnd()}\n\n${block}\n`;
  }

  return (
    existing.slice(0, open) +
    block +
    existing.slice(close + BLOCK_CLOSE.length)
  );
}
