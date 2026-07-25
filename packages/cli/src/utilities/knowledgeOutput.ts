import type {
  ContextPack,
  KnowledgeEntry,
  KnowledgeGap,
  KnowledgeHit,
  KnowledgePage,
  KnowledgePageRef,
  RememberResult,
} from '@vantikhq/agent-core';

import Table from 'cli-table3';

import { chalkGreen, chalkGrey, chalkWarning } from './cliOutput';

/**
 * Human-readable renderers for the knowledge commands.
 *
 * They format, they do not decide. No view on whether a fact was worth writing
 * down lives here — that opinion belongs to the MCP tool layer alone, and a
 * person at a terminal is not to be lectured about page hygiene.
 */

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function renderPageList(
  pages: Array<KnowledgePageRef & { parentId: string | null }>,
): string {
  if (pages.length === 0) {
    return chalkGrey('No pages yet.');
  }

  const byParent = new Map<string | null, typeof pages>();
  for (const page of pages) {
    const siblings = byParent.get(page.parentId ?? null) ?? [];
    siblings.push(page);
    byParent.set(page.parentId ?? null, siblings);
  }

  const lines: string[] = [];

  // Rendered as a tree rather than a flat list: where a page sits is half of
  // what its title means.
  const walk = (parentId: string | null, depth: number) => {
    for (const page of byParent.get(parentId) ?? []) {
      lines.push(`${'  '.repeat(depth)}${page.title} ${chalkGrey(page.id)}`);
      walk(page.id, depth + 1);
    }
  };

  walk(null, 0);

  return lines.join('\n');
}

export function renderPage(page: KnowledgePage): string {
  const breadcrumb = [...page.ancestors.map((a) => a.title), page.title].join(
    ' / ',
  );

  const parts = [
    chalkGreen(breadcrumb),
    chalkGrey(`${page.id} · entries ${page.entryPolicy}`),
    '',
    page.body || chalkGrey('(no body yet)'),
  ];

  if (page.standing.length > 0) {
    parts.push('', chalkGreen(`Standing facts (${page.standing.length})`));
    parts.push(renderEntries(page.standing));
  }

  return parts.join('\n');
}

export function renderEntries(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) {
    return chalkGrey('No entries.');
  }

  const table = new Table({
    head: ['id', 'status', 'scope', 'fact', 'served', 'ok'],
    style: { head: [], border: [] },
  });

  for (const entry of entries) {
    table.push([
      entry.id.slice(0, 8),
      entry.status,
      entry.scope ?? chalkGrey('—'),
      truncate(entry.content, 60),
      String(entry.retrievalCount),
      entry.verified ? '✓' : '',
    ]);
  }

  return table.toString();
}

export function renderHits(hits: KnowledgeHit[]): string {
  if (hits.length === 0) {
    return chalkGrey('Nothing in the bank matches that.');
  }

  return hits
    .map((hit) => {
      const badges = [
        hit.kind === 'page' ? 'page' : 'fact',
        hit.scope ?? null,
        hit.verified ? 'verified' : null,
      ]
        .filter(Boolean)
        .join(' · ');

      return [
        `${chalkGreen(hit.page.title)} ${chalkGrey(badges)}`,
        truncate(hit.content, 300),
      ].join('\n');
    })
    .join('\n\n');
}

export function renderContextPack(pack: ContextPack): string {
  const header = chalkGrey(
    `${pack.items.length} item(s), ~${pack.estimatedTokens}/${pack.tokenBudget} tokens` +
      (pack.omitted > 0 ? `, ${pack.omitted} omitted` : ''),
  );

  return [header, '', renderHits(pack.items)].join('\n');
}

export function renderRemember(result: RememberResult): string {
  if (result.status === 'written') {
    return `${chalkGreen('Remembered')} ${chalkGrey(result.entry.id)}`;
  }

  // Nothing was written, and saying so first matters more than the list: a
  // caller that skims this and moves on must not believe the fact is in.
  return [
    chalkWarning('Nothing written — similar entries already exist:'),
    '',
    renderHits(result.nearMatches),
    '',
    result.guidance,
  ].join('\n');
}

export function renderGaps(gaps: KnowledgeGap[]): string {
  if (gaps.length === 0) {
    return chalkGrey('No unanswered questions recorded.');
  }

  const table = new Table({
    head: ['asked', 'question'],
    style: { head: [], border: [] },
  });

  for (const gap of gaps) {
    table.push([String(gap.count), gap.query]);
  }

  return table.toString();
}

export function renderPageRef(page: KnowledgePageRef, verb: string): string {
  return `${chalkGreen(verb)} ${page.title} ${chalkGrey(page.id)}`;
}

export function renderTriage(result: {
  updated: number;
  skipped: number;
}): string {
  return [
    `${chalkGreen('Updated')} ${result.updated}`,
    result.skipped > 0
      ? chalkGrey(
          `${result.skipped} skipped — their current status does not allow it`,
        )
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
