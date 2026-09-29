import type {
  ConsolidateProposal,
  ContextPack,
  KnowledgeEntry,
  KnowledgeProof,
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

const TRUST: Record<string, string> = {
  HUMAN_VERIFIED: 'verified',
  GROUNDED: 'grounded',
  OBSERVED: 'observed',
  UNGROUNDED: 'ungrounded',
};

/**
 * What an item rests on and when that was last looked at, in one line:
 * "cites src/a.ts:40-52 (holds), issue ENG-12 (holds) · checked 2026-09-01 at
 * 1a2b3c4d5e6f". Empty when it cites nothing.
 */
export function renderProof(proof: KnowledgeProof): string {
  if (!proof.citations?.length) {
    return '';
  }

  const cited = proof.citations
    .map((citation) => {
      const what =
        citation.kind === 'CODE'
          ? `${citation.path}${citation.lines ? `:${citation.lines}` : ''}`
          : `${citation.kind.toLowerCase().replace('_', ' ')} ${citation.target}`;

      return `${what} (${(citation.result ?? 'unchecked').toLowerCase()})`;
    })
    .join(', ');

  const at = proof.lastCheckedSha
    ? ` at ${proof.lastCheckedSha.slice(0, 12)}`
    : '';
  const checked = proof.lastCheckedAt
    ? ` · checked ${proof.lastCheckedAt.slice(0, 10)}${at}`
    : '';

  return `cites ${cited}${checked}`;
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
    ...(page.kind === 'GENERATED'
      ? [chalkGrey(`Generated: answers "${page.question ?? ''}"`)]
      : []),
    '',
    page.body || chalkGrey('(no body yet)'),
  ];

  if (page.standing.length > 0) {
    parts.push('', chalkGreen(`Standing facts (${page.standing.length})`));
    parts.push(renderEntries(page.standing));
  }

  // What a generated page's sections rest on, section by section: the
  // prose above is a model's, and this is what it was written from.
  if (page.sections.length > 0) {
    const inUse = new Set(page.cited.map((entry) => entry.id));

    parts.push('', chalkGreen('Written from'));
    for (const section of page.sections) {
      parts.push(
        `${section.heading}: ${section.entryIds
          .map((id) =>
            inUse.has(id) ? id.slice(0, 8) : `${id.slice(0, 8)} (out of use)`,
          )
          .join(', ')}`,
      );
    }
  }

  if (page.cited.length > 0) {
    parts.push('', chalkGreen(`Cited facts (${page.cited.length})`));
    parts.push(renderEntries(page.cited));
  }

  return parts.join('\n');
}

export function renderEntries(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) {
    return chalkGrey('No entries.');
  }

  const table = new Table({
    head: ['id', 'status', 'scope', 'fact', 'served', 'trust'],
    style: { head: [], border: [] },
  });

  for (const entry of entries) {
    table.push([
      entry.id.slice(0, 8),
      entry.status,
      entry.scope ?? chalkGrey('—'),
      truncate(entry.content, 60),
      String(entry.retrievalCount),
      entry.trust ? TRUST[entry.trust] : entry.verified ? 'verified' : '',
    ]);
  }

  // Beneath the table, whole: a proof squeezed into a column would lose the
  // commit and the results, which are the point of it.
  const proofs = entries
    .map((entry) => ({ id: entry.id.slice(0, 8), proof: renderProof(entry) }))
    .filter(({ proof }) => proof)
    .map(({ id, proof }) => `${id}  ${chalkGrey(proof)}`);

  return [table.toString(), ...(proofs.length ? ['', ...proofs] : [])].join(
    '\n',
  );
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
        hit.trust ? TRUST[hit.trust] : hit.verified ? 'verified' : null,
        hit.evidenceFor ? `evidence for ${hit.evidenceFor.title}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const proof = renderProof(hit);

      return [
        `${chalkGreen(hit.page?.title ?? 'Outside any page')} ${chalkGrey(badges)}`,
        truncate(hit.content, 300),
        ...(proof ? [chalkGrey(proof)] : []),
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
    const proof = renderProof(result.entry);

    return [
      `${chalkGreen('Remembered')} ${chalkGrey(result.entry.id)}`,
      ...(proof ? [chalkGrey(proof)] : []),
    ].join('\n');
  }

  if (result.status === 'citation-failed') {
    return chalkWarning(result.message);
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

export function renderConsolidateProposal(
  proposal: ConsolidateProposal,
): string {
  return [
    `${chalkGreen('Proposed')} folding ${proposal.entryIds.length} ` +
      `entr${proposal.entryIds.length === 1 ? 'y' : 'ies'} into ` +
      `${proposal.page.title} ${chalkGrey(proposal.proposalId)}`,
    chalkGrey('Nothing changes until a person accepts it in the review queue.'),
  ].join('\n');
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
