import type { ContextPack } from './context-pack.service';

import { buildAgentPrompt } from './agent-prompt';
import { buildReviewPrompt, buildRevisionPrompt } from './review-prompt';

/**
 * What the reviewer and the reviser are told.
 *
 * The reviewer's prompt is the whole phase — a second model with the same
 * instructions as the first would just agree with it, and a second model told
 * to be critical without being told what counts as evidence produces a list of
 * opinions that costs a pass to churn on. So the tests here are about what the
 * two prompts must and must not carry.
 */

function packWith(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    version: 1,
    issue: {
      id: 'issue-1',
      key: 'ENG-42',
      title: 'Stop the importer dropping the last row',
      description: 'The loop exits one short.',
      state: 'Todo',
      stateCategory: 'UNSTARTED',
      priority: 'high',
      labels: [],
      team: { id: 'team-1', identifier: 'ENG', name: 'Engineering' },
      project: null,
      url: null,
    },
    definitionOfDone: [],
    subTasks: [],
    relations: [],
    comments: [],
    links: [],
    repo: {},
    knowledge: [],
    ...overrides,
  };
}

const CRITERIA = [
  { id: 'c1', body: 'The importer keeps the last row', completed: false },
  { id: 'c2', body: 'A regression test covers it', completed: false },
  { id: 'c3', body: 'Something already done', completed: true },
];

describe('the prompt the reviewer is given', () => {
  it('states the issue and the criteria the work is judged against', () => {
    const prompt = buildReviewPrompt(packWith({ definitionOfDone: CRITERIA }), {
      pass: 1,
      verification: [],
    });

    expect(prompt).toContain('ENG-42: Stop the importer dropping the last row');
    expect(prompt).toContain('The loop exits one short.');
    expect(prompt).toContain('1. The importer keeps the last row');
    expect(prompt).toContain('2. A regression test covers it');
  });

  it('numbers the criteria exactly as the implementer saw them', () => {
    // A finding that says "criterion 2" is worthless if the two prompts
    // disagree about which one that is, and a ticked criterion appearing in one
    // list and not the other shifts every number after it.
    const pack = packWith({ definitionOfDone: CRITERIA });

    const implementer = buildAgentPrompt(pack);
    const reviewer = buildReviewPrompt(pack, { pass: 1, verification: [] });

    for (const line of [
      '1. The importer keeps the last row',
      '2. A regression test covers it',
    ]) {
      expect(implementer).toContain(line);
      expect(reviewer).toContain(line);
    }

    expect(reviewer).not.toContain('Something already done');
  });

  it('tells the reviewer it did not write this and must not fix it', () => {
    // A reviewer that fixes what it finds has destroyed the only independent
    // read of the change anybody gets.
    const prompt = buildReviewPrompt(packWith(), { pass: 1, verification: [] });

    expect(prompt).toContain('You did not write this change');
    expect(prompt).toMatch(/Do not edit, create or delete a single file/);
  });

  it('hands over the checks as something already run', () => {
    // The execution-grounded signal the whole phase rests on. A reviewer told
    // to go and run the tests itself may not, and one that speculates about
    // whether the code works is the self-correction this replaced.
    const prompt = buildReviewPrompt(packWith(), {
      pass: 1,
      verification: [
        {
          label: 'Tests',
          command: 'pnpm test',
          ok: false,
          output: 'FAIL 3 of 40',
        },
        { label: 'Lint', command: 'pnpm lint', ok: true },
      ],
    });

    expect(prompt).toContain('were run against this tree just now');
    expect(prompt).toContain('**Tests** (`pnpm test`): FAILED');
    expect(prompt).toContain('**Lint** (`pnpm lint`): passed');
    expect(prompt).toContain('FAIL 3 of 40');
  });

  it('says plainly when there was nothing to run', () => {
    // Silence here would read as "the checks passed", which is the one thing
    // it does not mean.
    const prompt = buildReviewPrompt(packWith(), { pass: 1, verification: [] });

    expect(prompt).toContain(
      'declares no test, lint, typecheck or build command',
    );
  });

  it('points at the diff rather than at the directory', () => {
    const prompt = buildReviewPrompt(packWith(), { pass: 1, verification: [] });

    expect(prompt).toContain('/workspace/base');
    expect(prompt).toContain('tree-tools.sh diff');
  });

  it('demands the verdict outside the checkout', () => {
    // Written inside it, the reviewer's own answer lands in the diff a human
    // reviews.
    const prompt = buildReviewPrompt(packWith(), { pass: 2, verification: [] });

    expect(prompt).toContain('/workspace/review-2.json');
    expect(prompt).not.toContain('/workspace/repo/review');
  });

  it('says that a finding without evidence will not be read', () => {
    const prompt = buildReviewPrompt(packWith(), { pass: 1, verification: [] });

    expect(prompt).toContain('discarded');
    expect(prompt).toContain('"evidence": "src/thing.ts:42"');
  });
});

describe('the prompt the next pass is given', () => {
  const findings = [
    {
      message: 'The off-by-one is still there',
      evidence: 'src/importer.ts:88',
      severity: 'high' as const,
      criterion: 1,
    },
    {
      message: 'No test covers the empty case',
      evidence: 'src/importer.spec.ts:1',
    },
  ];

  it('restates the issue, because this is a process with no memory', () => {
    // An agent handed only a findings list fixes the findings and drifts off
    // the issue while it does.
    const prompt = buildRevisionPrompt({
      pack: packWith({ definitionOfDone: CRITERIA }),
      pass: 2,
      findings,
      verification: [],
    });

    expect(prompt).toContain('ENG-42: Stop the importer dropping the last row');
    expect(prompt).toContain('The loop exits one short.');
    expect(prompt).toContain('1. The importer keeps the last row');
  });

  it('lists the findings with what they point at', () => {
    const prompt = buildRevisionPrompt({
      pack: packWith(),
      pass: 2,
      findings,
      verification: [],
    });

    expect(prompt).toContain('1. The off-by-one is still there');
    expect(prompt).toContain('where: src/importer.ts:88');
    expect(prompt).toContain('high, criterion 1');
    expect(prompt).toContain('2. No test covers the empty case');
  });

  it('allows the implementer to disagree with a finding', () => {
    // A reviewer misreading the code is common, and an implementer that must
    // satisfy every finding will change working code to silence one.
    const prompt = buildRevisionPrompt({
      pack: packWith(),
      pass: 2,
      findings,
      verification: [],
    });

    expect(prompt).toContain('do not change the code to satisfy it');
    expect(prompt).toContain('`disagree`');
  });

  it('carries the failing checks and refuses the obvious way to silence them', () => {
    const prompt = buildRevisionPrompt({
      pack: packWith(),
      pass: 2,
      findings,
      verification: [
        {
          label: 'Tests',
          command: 'pnpm test',
          ok: false,
          output: 'expected 41, got 40',
        },
        { label: 'Lint', command: 'pnpm lint', ok: true },
      ],
    });

    expect(prompt).toContain('**Tests** (`pnpm test`)');
    expect(prompt).toContain('expected 41, got 40');
    expect(prompt).not.toContain('**Lint**');
    expect(prompt).toContain('Fix the cause rather than the check');
  });

  it('leaves the delivery to the host, the same as the first pass', () => {
    const prompt = buildRevisionPrompt({
      pack: packWith(),
      pass: 3,
      findings,
      verification: [],
    });

    expect(prompt).toContain('Do not commit, branch, push or');
  });
});
