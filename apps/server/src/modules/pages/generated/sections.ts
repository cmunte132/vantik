import { createHash, randomUUID } from 'node:crypto';

import {
  applyOperations as apply,
  type AppliedOperations as Applied,
  type EditGuard,
} from '@vantikhq/llm-tasks';
import { type PageSection } from '@vantikhq/types';

/**
 * A generated page's body, as sections, and the edits a refresh makes to it.
 *
 * A refresh never rewrites a page. The model that reads the new evidence
 * answers with operations against section ids, and they are applied here, in
 * code: a section no operation names is the same object afterwards, so it is
 * stored byte for byte as it was, and an operation that names a section the
 * page does not have is dropped rather than guessed at. A section always
 * cites the entries it was written from, and only entries the refresh read.
 *
 * Nor can a refresh rewrite what has not changed. Each section records a
 * fingerprint of what it was written from, and one whose fingerprint still
 * matches is neither replaced nor removed: what new evidence adds goes in a
 * new section. So one answer can change only the sections whose evidence
 * moved, whatever it asks for.
 */

export {
  type DroppedOperation,
  type EditGuard,
  MAX_OPERATIONS,
  parseOperations,
  type SectionOperation,
} from '@vantikhq/llm-tasks';

/** An entry as a fingerprint reads it: what it says. */
export interface EvidenceEntry {
  kind: string;
  content: string;
}

export type AppliedOperations = Applied<PageSection>;

/**
 * The sections a page stores, or none. The column is JSON, so anything that
 * is not a list of well-formed sections is read as no sections rather than
 * trusted: a refresh then starts the page again, which is recorded in its
 * history like any other.
 */
export function readSections(stored: unknown): PageSection[] {
  if (!Array.isArray(stored)) {
    return [];
  }

  return stored.filter(
    (section): section is PageSection =>
      isRecord(section) &&
      typeof section.id === 'string' &&
      typeof section.heading === 'string' &&
      typeof section.body === 'string' &&
      Array.isArray(section.entryIds) &&
      section.entryIds.every((id: unknown) => typeof id === 'string'),
  );
}

/** Every entry the sections cite, once each, in the order they are cited. */
export function citedBy(sections: PageSection[]): string[] {
  return [...new Set(sections.flatMap((section) => section.entryIds))];
}

/**
 * The sections as one markdown body: what `Page.description` holds, so a
 * search, an agent's `get_page` and the editor read a generated page the way
 * they read any other.
 */
export function renderSections(sections: PageSection[]): string {
  return sections
    .map((section) => `## ${section.heading}\n\n${section.body.trim()}`)
    .join('\n\n');
}

/**
 * The fingerprint of what a section rests on: the question the page answers,
 * and each entry it cites, by what it says, or as gone when it is no longer
 * among `entries` (out of use, or out of the page's scope). The order of the
 * ids does not matter, and neither does any entry the section does not cite.
 */
export function sectionEvidence(
  question: string,
  entryIds: string[],
  entries: ReadonlyMap<string, EvidenceEntry>,
): string {
  const cited = [...new Set(entryIds)].sort().map((id) => {
    const entry = entries.get(id);

    return entry ? [id, entry.kind, entry.content] : [id, null];
  });

  return createHash('sha256')
    .update(JSON.stringify([question, cited]))
    .digest('hex')
    .slice(0, 32);
}

/** A new section's id: stable from then on, and never reused. */
export function newSectionId(): string {
  return `sec_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Applies operations to the sections, in the order given; see
 * `applyOperations` in `@vantikhq/llm-tasks`, where the rules live so the
 * evals apply a model's answer exactly as a refresh does.
 */
export function applyOperations(
  current: PageSection[],
  operations: unknown[],
  evidence: ReadonlySet<string>,
  makeId: () => string = newSectionId,
  guard?: EditGuard,
): AppliedOperations {
  return apply(current, operations, evidence, makeId, guard);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
