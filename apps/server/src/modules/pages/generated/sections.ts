import { createHash, randomUUID } from 'node:crypto';

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

export type SectionOperation =
  | {
      op: 'replace_section';
      id: string;
      heading: string;
      body: string;
      entryIds: string[];
    }
  | {
      op: 'insert_section';
      /** The section it goes after, or null for the top of the page. */
      after: string | null;
      heading: string;
      body: string;
      entryIds: string[];
    }
  | { op: 'remove_section'; id: string };

/** An operation that was not applied, and why. */
export interface DroppedOperation {
  operation: unknown;
  reason: string;
}

/**
 * What keeps a refresh to the sections whose evidence changed: which ones it
 * may replace or remove, and the fingerprint to record on a section it
 * writes, from the entries it cites.
 */
export interface EditGuard {
  editable: ReadonlySet<string>;
  stamp: (entryIds: string[]) => string;
}

/** An entry as a fingerprint reads it: what it says. */
export interface EvidenceEntry {
  kind: string;
  content: string;
}

export interface AppliedOperations {
  sections: PageSection[];
  applied: SectionOperation[];
  dropped: DroppedOperation[];
}

/** The most operations one refresh applies; the rest are dropped. */
export const MAX_OPERATIONS = 30;
const MAX_HEADING_LENGTH = 200;
const MAX_BODY_LENGTH = 6_000;

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
 * Applies operations to the sections, in the order given.
 *
 * `evidence` is every entry the refresh read. A written section must cite at
 * least one of them, and cites only those: an entry id the model made up, or
 * one it was not shown, is dropped from the section, and a section left
 * citing nothing is not written, since every section says what it was
 * written from. An id an earlier operation removed is unknown to a later
 * one, as it would be to a reader.
 *
 * With a `guard`, a section it does not list as editable is neither replaced
 * nor removed, and every section written records its fingerprint.
 */
export function applyOperations(
  current: PageSection[],
  operations: unknown[],
  evidence: ReadonlySet<string>,
  makeId: () => string = newSectionId,
  guard?: EditGuard,
): AppliedOperations {
  const sections = [...current];
  const applied: SectionOperation[] = [];
  const dropped: DroppedOperation[] = [];
  const drop = (operation: unknown, reason: string) =>
    dropped.push({ operation, reason });

  for (const [index, raw] of operations.entries()) {
    if (index >= MAX_OPERATIONS) {
      drop(raw, `more than ${MAX_OPERATIONS} operations`);
      continue;
    }

    const operation = readOperation(raw);

    if (typeof operation === 'string') {
      drop(raw, operation);
      continue;
    }

    if (
      operation.op !== 'insert_section' &&
      guard &&
      !guard.editable.has(operation.id) &&
      sections.some((section) => section.id === operation.id)
    ) {
      drop(raw, `the evidence of section ${operation.id} has not changed`);
      continue;
    }

    if (operation.op === 'remove_section') {
      const at = sections.findIndex((section) => section.id === operation.id);

      if (at < 0) {
        drop(raw, `no section ${operation.id}`);
        continue;
      }

      sections.splice(at, 1);
      applied.push(operation);
      continue;
    }

    const entryIds = [...new Set(operation.entryIds)].filter((id) =>
      evidence.has(id),
    );

    if (entryIds.length === 0) {
      drop(raw, 'cites none of the entries read');
      continue;
    }

    if (operation.op === 'replace_section') {
      const at = sections.findIndex((section) => section.id === operation.id);

      if (at < 0) {
        drop(raw, `no section ${operation.id}`);
        continue;
      }

      sections[at] = {
        id: operation.id,
        heading: operation.heading,
        body: operation.body,
        entryIds,
        ...(guard ? { evidence: guard.stamp(entryIds) } : {}),
      };
      applied.push({ ...operation, entryIds });
      continue;
    }

    const after =
      operation.after === null
        ? -1
        : sections.findIndex((section) => section.id === operation.after);

    if (after < 0 && operation.after !== null) {
      drop(raw, `no section ${operation.after} to insert after`);
      continue;
    }

    sections.splice(after + 1, 0, {
      id: makeId(),
      heading: operation.heading,
      body: operation.body,
      entryIds,
      ...(guard ? { evidence: guard.stamp(entryIds) } : {}),
    });
    applied.push({ ...operation, entryIds });
  }

  return { sections, applied, dropped };
}

/**
 * The operations in a model's answer, or null when the answer cannot be
 * read. The answer is JSON, `{ "operations": [...] }`, possibly inside a
 * code fence; anything else is not guessed at, and the refresh writes
 * nothing.
 */
export function parseOperations(text: string): unknown[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start < 0 || end < start) {
    return null;
  }

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));

    return isRecord(parsed) && Array.isArray(parsed.operations)
      ? parsed.operations
      : null;
  } catch {
    return null;
  }
}

/** One operation, checked field by field, or why it cannot be applied. */
function readOperation(raw: unknown): SectionOperation | string {
  if (!isRecord(raw)) {
    return 'not an operation';
  }

  if (raw.op === 'remove_section') {
    return typeof raw.id === 'string' && raw.id
      ? { op: 'remove_section', id: raw.id }
      : 'no section id';
  }

  if (raw.op !== 'replace_section' && raw.op !== 'insert_section') {
    return `unknown operation ${String(raw.op)}`;
  }

  const heading = typeof raw.heading === 'string' ? raw.heading.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';

  if (
    !heading ||
    heading.length > MAX_HEADING_LENGTH ||
    heading.includes('\n')
  ) {
    return 'no heading, or not one line';
  }

  if (!body || body.length > MAX_BODY_LENGTH) {
    return 'no body, or too long';
  }

  const entryIds = Array.isArray(raw.entryIds)
    ? raw.entryIds.filter((id): id is string => typeof id === 'string')
    : [];

  if (raw.op === 'replace_section') {
    return typeof raw.id === 'string' && raw.id
      ? { op: 'replace_section', id: raw.id, heading, body, entryIds }
      : 'no section id';
  }

  if (raw.after !== null && (typeof raw.after !== 'string' || !raw.after)) {
    return 'no section to insert after';
  }

  return {
    op: 'insert_section',
    after: raw.after as string | null,
    heading,
    body,
    entryIds,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
