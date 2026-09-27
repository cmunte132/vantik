import type { ContextPack } from './context-pack.service';

import {
  KnowledgeTrustEnum,
  PageEntryCitationCheckEnum,
  PageEntryCitationKindEnum,
} from '@vantikhq/types';

import { buildAgentPrompt } from './agent-prompt';

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

describe('the prompt an agent is given', () => {
  it('names the issue and states the problem', () => {
    const prompt = buildAgentPrompt(packWith());

    expect(prompt).toContain('ENG-42: Stop the importer dropping the last row');
    expect(prompt).toContain('The loop exits one short.');
  });

  it('lists the open criteria, numbered, and leaves the ticked ones out', () => {
    // Numbered so the closing report can answer them one by one. A criterion
    // already met is not work this run has to do, and restating it invites a
    // diff that redoes it.
    const prompt = buildAgentPrompt(
      packWith({
        definitionOfDone: [
          {
            id: 'c1',
            body: 'The importer keeps the last row',
            completed: false,
          },
          { id: 'c2', body: 'A regression test covers it', completed: false },
          { id: 'c3', body: 'Already done earlier', completed: true },
        ],
      }),
    );

    expect(prompt).toContain('1. The importer keeps the last row');
    expect(prompt).toContain('2. A regression test covers it');
    expect(prompt).not.toContain('Already done earlier');
  });

  it('has no Definition of Done section when the issue set no criteria', () => {
    // A blank heading reads to a model as an instruction it failed to receive.
    expect(buildAgentPrompt(packWith())).not.toContain('## Definition of Done');
  });

  it('asks for test-first work only where there is a test command to run', () => {
    // Telling an agent to write a failing test in a repository whose runner we
    // cannot name produces a file it invents a runner for, which is worse than
    // no test.
    expect(
      buildAgentPrompt(packWith({ repo: { testCommand: 'pnpm test' } })),
    ).toContain('Watch it fail');

    expect(buildAgentPrompt(packWith({ repo: {} }))).not.toContain(
      'Watch it fail',
    );
  });

  it('states the repository’s own checks as instructions', () => {
    const prompt = buildAgentPrompt(
      packWith({
        repo: {
          testCommand: 'pnpm test',
          lintCommand: 'pnpm lint',
          typecheckCommand: 'pnpm typecheck',
        },
      }),
    );

    expect(prompt).toContain('- Tests: `pnpm test`');
    expect(prompt).toContain('- Typecheck: `pnpm typecheck`');
    expect(prompt).toContain('- Lint: `pnpm lint`');
    expect(prompt).toContain('fix the');
  });

  it('asks for a closing report the reviewer can check against the criteria', () => {
    // The whole handback comment is rendered from this. Without it the agent
    // says "done" and a reviewer has to diff the branch to find out against
    // what.
    const prompt = buildAgentPrompt(
      packWith({
        definitionOfDone: [
          { id: 'c1', body: 'Keeps the row', completed: false },
        ],
      }),
    );

    expect(prompt).toContain('met');
    expect(prompt).toContain('not applicable');
  });

  it('puts the delegating person’s guidance above the criteria', () => {
    // It is how they want the work approached, and an instruction about
    // approach is worth nothing once the approach has been chosen.
    const prompt = buildAgentPrompt(
      packWith({
        guidance: 'Do not touch the CSV parser.',
        definitionOfDone: [
          { id: 'c1', body: 'Keeps the row', completed: false },
        ],
      }),
    );

    expect(prompt.indexOf('Do not touch the CSV parser.')).toBeLessThan(
      prompt.indexOf('## Definition of Done'),
    );
  });

  it('tells the agent where in a monorepo to start', () => {
    expect(
      buildAgentPrompt(
        packWith({ repo: { pathPrefixes: ['apps/server/', 'packages/db/'] } }),
      ),
    ).toContain('apps/server/, packages/db/');
  });

  it('never tells the agent to commit, branch or open a pull request', () => {
    // Delivery is host-side. An agent that pushes bypasses the git proxy, which
    // is the control keeping the token out of the guest.
    const prompt = buildAgentPrompt(packWith());

    expect(prompt).toContain('Do not commit');
    expect(prompt).toContain('open a pull request');
  });

  it('[KG-2.8] gives every item of knowledge its trust tier, citations and last check', () => {
    const prompt = buildAgentPrompt(
      packWith({
        knowledge: [
          {
            entryId: 'entry-1',
            kind: 'FACT',
            writtenAt: '2026-08-01T09:00:00.000Z',
            scope: 'apps/server',
            body: 'Redis holds only cache here.',
            trust: KnowledgeTrustEnum.GROUNDED,
            citations: [
              {
                kind: PageEntryCitationKindEnum.CODE,
                repo: 'acme/api',
                path: 'src/cache.ts',
                lines: '12-30',
                commitSha: 'abcdef1',
                result: PageEntryCitationCheckEnum.MOVED,
                checkedAt: '2026-09-20T10:00:00.000Z',
                checkedSha: '9f8e7d6c5b4a3210',
              },
            ],
            lastCheckedAt: '2026-09-20T10:00:00.000Z',
            lastCheckedSha: '9f8e7d6c5b4a3210',
          },
          {
            entryId: 'entry-2',
            kind: 'GOTCHA',
            writtenAt: '2026-09-02T09:00:00.000Z',
            scope: null,
            body: 'Deploys drain the worker pool first.',
            trust: KnowledgeTrustEnum.UNGROUNDED,
            citations: [],
            lastCheckedAt: null,
            lastCheckedSha: null,
          },
        ],
      }),
    );

    expect(prompt).toContain('## What this workspace already knows');
    expect(prompt).toContain(
      '- (apps/server) Redis holds only cache here.\n  _grounded · cites ' +
        'acme/api:src/cache.ts:12-30 (moved) · checked 2026-09-20 at ' +
        '9f8e7d6c5b4a · written 2026-08-01_',
    );
    expect(prompt).toContain(
      '- Deploys drain the worker pool first.\n  _ungrounded · cites nothing' +
        ' · written 2026-09-02_',
    );
    expect(prompt).toContain('Check an ungrounded claim before relying on it');
  });

  it('[KG-3.2] renders each item with its citation and its age', () => {
    const prompt = buildAgentPrompt(
      packWith({
        knowledge: [
          {
            entryId: 'entry-1',
            kind: 'CONVENTION',
            writtenAt: '2026-05-14T09:00:00.000Z',
            scope: 'apps/server/prisma',
            body: 'Migrations are written by hand.',
            trust: KnowledgeTrustEnum.HUMAN_VERIFIED,
            citations: [
              {
                kind: PageEntryCitationKindEnum.CODE,
                repo: 'acme/api',
                path: 'prisma/migrations/README.md',
                lines: '1-4',
                commitSha: 'abcdef1',
                result: PageEntryCitationCheckEnum.HOLDS,
                checkedAt: '2026-09-21T10:00:00.000Z',
                checkedSha: '0123456789abcdef',
              },
            ],
            lastCheckedAt: '2026-09-21T10:00:00.000Z',
            lastCheckedSha: '0123456789abcdef',
          },
        ],
      }),
    );

    const line = prompt
      .split('\n')
      .find((text) => text.startsWith('  _verified by a person'));
    expect(line).toContain('cites acme/api:prisma/migrations/README.md:1-4');
    expect(line).toContain('written 2026-05-14');
  });
});
