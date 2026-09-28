import { type PageSection } from '@vantikhq/types';

import {
  applyOperations,
  citedBy,
  MAX_OPERATIONS,
  newSectionId,
  parseOperations,
  readSections,
  renderSections,
} from './sections';

/**
 * A generated page's sections, and the edits a refresh makes to them. The
 * model answers with operations against section ids; they are applied here,
 * in code, and nothing else about the page changes.
 */

const SECTIONS: PageSection[] = [
  {
    id: 'sec_setup',
    heading: 'Setting up',
    body: 'Run `pnpm install`, then `pnpm dev`.',
    entryIds: ['e-install'],
  },
  {
    id: 'sec_deploy',
    heading: 'Deploying',
    body: 'Deploys go out from `main` on merge.',
    entryIds: ['e-deploy', 'e-ci'],
  },
  {
    id: 'sec_rollback',
    heading: 'Rolling back',
    body: 'Revert the merge commit; the next deploy rolls back.',
    entryIds: ['e-rollback'],
  },
];

const EVIDENCE = new Set([
  'e-install',
  'e-deploy',
  'e-ci',
  'e-rollback',
  'e-canary',
]);

let counter = 0;
const ids = () => `sec_new${++counter}`;

/** The sections as they would be stored. */
const stored = (sections: PageSection[]) => JSON.stringify(sections);

describe('the sections of a generated page', () => {
  beforeEach(() => {
    counter = 0;
  });

  it('[KG-7.3] keeps every section no operation names byte for byte', () => {
    const before = structuredClone(SECTIONS);
    const { sections, applied, dropped } = applyOperations(
      SECTIONS,
      [
        {
          op: 'replace_section',
          id: 'sec_deploy',
          heading: 'Deploying',
          body: 'Deploys go out from `main` on merge, behind a canary.',
          entryIds: ['e-deploy', 'e-canary'],
        },
      ],
      EVIDENCE,
      ids,
    );

    expect(dropped).toEqual([]);
    expect(applied).toHaveLength(1);
    // The same objects, not copies that happen to look alike: nothing about
    // them is rewritten, reordered or tidied.
    expect(sections[0]).toBe(SECTIONS[0]);
    expect(sections[2]).toBe(SECTIONS[2]);
    expect(JSON.stringify(sections[0])).toBe(JSON.stringify(before[0]));
    expect(JSON.stringify(sections[2])).toBe(JSON.stringify(before[2]));
    expect(sections[1]).toEqual({
      id: 'sec_deploy',
      heading: 'Deploying',
      body: 'Deploys go out from `main` on merge, behind a canary.',
      entryIds: ['e-deploy', 'e-canary'],
    });
    // The page the operations were applied to is not touched.
    expect(stored(SECTIONS)).toBe(stored(before));
  });

  it('[KG-7.3] keeps the whole page byte for byte when there is nothing to do', () => {
    const { sections, applied } = applyOperations(SECTIONS, [], EVIDENCE, ids);

    expect(applied).toEqual([]);
    expect(stored(sections)).toBe(stored(SECTIONS));
    sections.forEach((section, index) => expect(section).toBe(SECTIONS[index]));
  });

  it('[KG-7.3] drops an operation naming a section the page does not have, and applies the rest', () => {
    const { sections, applied, dropped } = applyOperations(
      SECTIONS,
      [
        {
          op: 'replace_section',
          id: 'sec_missing',
          heading: 'Monitoring',
          body: 'Dashboards are in Grafana.',
          entryIds: ['e-deploy'],
        },
        { op: 'remove_section', id: 'sec_gone' },
        {
          op: 'insert_section',
          after: 'sec_nowhere',
          heading: 'Canaries',
          body: 'Every deploy goes to a canary first.',
          entryIds: ['e-canary'],
        },
        { op: 'remove_section', id: 'sec_rollback' },
      ],
      EVIDENCE,
      ids,
    );

    expect(dropped.map((drop) => drop.reason)).toEqual([
      'no section sec_missing',
      'no section sec_gone',
      'no section sec_nowhere to insert after',
    ]);
    expect(applied).toEqual([{ op: 'remove_section', id: 'sec_rollback' }]);
    expect(sections).toEqual([SECTIONS[0], SECTIONS[1]]);
  });

  it('[KG-7.3] treats a section an earlier operation removed as unknown to a later one', () => {
    const { sections, dropped } = applyOperations(
      SECTIONS,
      [
        { op: 'remove_section', id: 'sec_deploy' },
        {
          op: 'replace_section',
          id: 'sec_deploy',
          heading: 'Deploying',
          body: 'Back again.',
          entryIds: ['e-deploy'],
        },
      ],
      EVIDENCE,
      ids,
    );

    expect(dropped.map((drop) => drop.reason)).toEqual([
      'no section sec_deploy',
    ]);
    expect(sections.map((section) => section.id)).toEqual([
      'sec_setup',
      'sec_rollback',
    ]);
  });

  it('[KG-7.3] inserts a new section where it is asked, with an id of its own', () => {
    const { sections } = applyOperations(
      SECTIONS,
      [
        {
          op: 'insert_section',
          after: 'sec_deploy',
          heading: 'Canaries',
          body: 'Every deploy goes to a canary first.',
          entryIds: ['e-canary'],
        },
        {
          op: 'insert_section',
          after: null,
          heading: 'In short',
          body: 'Merge to deploy; revert to roll back.',
          entryIds: ['e-deploy', 'e-rollback'],
        },
      ],
      EVIDENCE,
      ids,
    );

    expect(sections.map((section) => section.id)).toEqual([
      'sec_new2',
      'sec_setup',
      'sec_deploy',
      'sec_new1',
      'sec_rollback',
    ]);
    expect(sections[3]).toEqual({
      id: 'sec_new1',
      heading: 'Canaries',
      body: 'Every deploy goes to a canary first.',
      entryIds: ['e-canary'],
    });
    // A model never picks a section's id.
    expect(newSectionId()).toMatch(/^sec_[0-9a-f]{12}$/);
    expect(newSectionId()).not.toBe(newSectionId());
  });

  it('[KG-7.1] [KG-7.3] writes a section only citing entries the refresh read', () => {
    const { sections, applied, dropped } = applyOperations(
      SECTIONS,
      [
        {
          op: 'replace_section',
          id: 'sec_setup',
          heading: 'Setting up',
          body: 'Run `pnpm install`; Node 22 is required.',
          // One read, one invented, one repeated.
          entryIds: ['e-install', 'e-invented', 'e-install'],
        },
        {
          op: 'insert_section',
          after: null,
          heading: 'Secrets',
          body: 'Ask in #ops for the staging keys.',
          entryIds: ['e-not-shown'],
        },
        {
          op: 'replace_section',
          id: 'sec_rollback',
          heading: 'Rolling back',
          body: 'Nothing cited.',
          entryIds: [],
        },
      ],
      EVIDENCE,
      ids,
    );

    expect(sections[0]).toEqual({
      id: 'sec_setup',
      heading: 'Setting up',
      body: 'Run `pnpm install`; Node 22 is required.',
      entryIds: ['e-install'],
    });
    expect(applied[0]).toMatchObject({ entryIds: ['e-install'] });
    expect(dropped.map((drop) => drop.reason)).toEqual([
      'cites none of the entries read',
      'cites none of the entries read',
    ]);
    expect(sections).toHaveLength(3);
    expect(sections[2]).toBe(SECTIONS[2]);
    for (const section of sections) {
      expect(section.entryIds.length).toBeGreaterThan(0);
    }
  });

  it('[KG-7.3] drops what is not an operation it knows, field by field', () => {
    const good = {
      op: 'replace_section',
      id: 'sec_setup',
      heading: 'Setting up',
      body: 'Run it.',
      entryIds: ['e-install'],
    };
    const { dropped, applied } = applyOperations(
      SECTIONS,
      [
        'rewrite everything',
        null,
        { op: 'rewrite_page', body: 'All new.' },
        { ...good, id: '' },
        { ...good, id: 7 },
        { ...good, heading: '' },
        { ...good, heading: 'Two\nlines' },
        { ...good, heading: 'x'.repeat(201) },
        { ...good, body: '   ' },
        { ...good, body: 'x'.repeat(6_001) },
        { op: 'insert_section', heading: 'Where?', body: 'b', entryIds: [] },
        { op: 'remove_section' },
      ],
      EVIDENCE,
      ids,
    );

    expect(applied).toEqual([]);
    expect(dropped.map((drop) => drop.reason)).toEqual([
      'not an operation',
      'not an operation',
      'unknown operation rewrite_page',
      'no section id',
      'no section id',
      'no heading, or not one line',
      'no heading, or not one line',
      'no heading, or not one line',
      'no body, or too long',
      'no body, or too long',
      'no section to insert after',
      'no section id',
    ]);
  });

  it('[KG-7.3] applies at most thirty operations from one answer', () => {
    const many = Array.from({ length: MAX_OPERATIONS + 2 }, (_, index) => ({
      op: 'insert_section',
      after: null as string | null,
      heading: `Section ${index}`,
      body: 'b',
      entryIds: ['e-install'],
    }));
    const { applied, dropped } = applyOperations([], many, EVIDENCE, ids);

    expect(MAX_OPERATIONS).toBe(30);
    expect(applied).toHaveLength(MAX_OPERATIONS);
    expect(dropped).toHaveLength(2);
    expect(dropped[0].reason).toBe(`more than ${MAX_OPERATIONS} operations`);
  });

  it('[KG-7.3] reads operations from a JSON answer, and nothing from anything else', () => {
    expect(parseOperations('{"operations": []}')).toEqual([]);
    expect(
      parseOperations(
        '```json\n{"operations": [{"op": "remove_section", "id": "sec_a"}]}\n```',
      ),
    ).toEqual([{ op: 'remove_section', id: 'sec_a' }]);

    for (const unreadable of [
      '',
      'Here is the new page: ...',
      '{"operations": "none"}',
      '{"sections": []}',
      '[{"op": "remove_section", "id": "sec_a"}]',
      '{"operations": [',
    ]) {
      expect(parseOperations(unreadable)).toBeNull();
    }
  });

  it('[KG-7.1] reads stored sections, and what they cite, without trusting the column', () => {
    expect(readSections(SECTIONS)).toEqual(SECTIONS);
    expect(readSections(null)).toEqual([]);
    expect(readSections('sections')).toEqual([]);
    expect(
      readSections([
        SECTIONS[0],
        { id: 'sec_x', heading: 'No body', entryIds: [] },
        { ...SECTIONS[1], entryIds: [1, 2] },
      ]),
    ).toEqual([SECTIONS[0]]);

    expect(citedBy(SECTIONS)).toEqual([
      'e-install',
      'e-deploy',
      'e-ci',
      'e-rollback',
    ]);
    expect(citedBy([SECTIONS[1], SECTIONS[1]])).toEqual(['e-deploy', 'e-ci']);
  });

  it('[KG-7.1] renders the sections as the page body, heading by heading', () => {
    expect(renderSections(SECTIONS.slice(0, 2))).toBe(
      '## Setting up\n\nRun `pnpm install`, then `pnpm dev`.\n\n' +
        '## Deploying\n\nDeploys go out from `main` on merge.',
    );
    expect(renderSections([])).toBe('');
  });
});
