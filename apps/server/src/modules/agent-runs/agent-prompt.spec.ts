import type { ContextPack } from './context-pack.service';

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
});
