import {
  newOutboxState,
  OUTBOX_LIMITS,
  readOutbox,
  RunOutboxService,
} from './run-outbox';

const PACK = {
  definitionOfDone: [
    { id: 'c1', body: 'Keeps the last row', completed: false },
  ],
};
const lines = (...items: unknown[]) =>
  items.map((item) => `${JSON.stringify(item)}\n`).join('');

describe('reading an agent’s outbox', () => {
  it('reads each line once, across passes, and leaves a half-written line for later', () => {
    const state = newOutboxState();
    const first = lines({ v: 1, type: 'note', body: 'one' });

    expect(readOutbox(first, PACK, state).notes).toEqual([{ body: 'one' }]);

    const grown = `${first}${lines({ v: 1, type: 'note', body: 'two' })}{"v":1,"type":"no`;
    expect(readOutbox(grown, PACK, state).notes).toEqual([{ body: 'two' }]);
    expect(state.lines).toBe(2);
  });

  it('holds criteria to this issue’s and to evidence', () => {
    const state = newOutboxState();
    const batch = readOutbox(
      lines(
        { v: 1, type: 'criterion', id: 'c1', evidence: 'the spec passes' },
        { v: 1, type: 'criterion', id: 'other-issue', evidence: 'x' },
        { v: 1, type: 'criterion', id: 'c1', evidence: '  ' },
      ),
      PACK,
      state,
    );

    expect(batch.criteria).toEqual([{ id: 'c1', evidence: 'the spec passes' }]);
    expect(batch.rejected.map((r) => r.reason)).toEqual([
      'not a criterion of this issue',
      'no evidence',
    ]);
    expect([...state.criteria.keys()]).toEqual(['c1']);
  });

  it('caps notes and facts per run, and refuses what it cannot read', () => {
    const state = newOutboxState();
    const notes = Array.from({ length: OUTBOX_LIMITS.notes + 2 }, (_, i) => ({
      v: 1,
      type: 'note',
      body: `note ${i}`,
    }));
    const batch = readOutbox(
      `${lines(
        ...notes,
        { v: 2, type: 'note', body: 'x' },
        { v: 1, type: 'shell', cmd: 'rm' },
      )}not json\n`,
      PACK,
      state,
    );

    expect(batch.notes).toHaveLength(OUTBOX_LIMITS.notes);
    expect(batch.rejected.map((r) => r.reason)).toEqual([
      'too many notes',
      'too many notes',
      'unknown record',
      'unknown record',
      'not JSON',
    ]);
  });

  it('keeps a fact’s citations to paths in the repository', () => {
    const batch = readOutbox(
      lines({
        v: 1,
        type: 'remember',
        content: 'Rows are paged by 500.',
        kind: 'GOTCHA',
        citations: [
          { path: 'src/importer.ts', lines: '80-90' },
          { path: '/etc/passwd' },
          { path: 'src/../../outside' },
          { path: 'src/a.ts', lines: 'all of them' },
        ],
      }),
      PACK,
      newOutboxState(),
    );

    expect(batch.facts).toEqual([
      {
        content: 'Rows are paged by 500.',
        kind: 'GOTCHA',
        citations: [
          { path: 'src/importer.ts', lines: '80-90' },
          { path: 'src/a.ts' },
        ],
      },
    ]);
  });

  it('refuses a fact too long to be one', () => {
    const batch = readOutbox(
      lines({
        v: 1,
        type: 'remember',
        content: 'x'.repeat(OUTBOX_LIMITS.factLength + 1),
      }),
      PACK,
      newOutboxState(),
    );

    expect(batch.facts).toEqual([]);
    expect(batch.rejected[0].reason).toBe('empty or oversized fact');
  });
});

describe('reading the questions in an outbox', () => {
  const ask = (over: Record<string, unknown> = {}) => ({
    v: 1,
    type: 'question',
    id: 'ask-1',
    questions: [{ id: 'q', prompt: 'Which?' }],
    ...over,
  });

  it('reads a question with its deadline', () => {
    const batch = readOutbox(
      lines(ask({ expiresAt: '2026-10-09T10:00:00.000Z' })),
      PACK,
      newOutboxState(),
    );

    expect(batch.questions).toHaveLength(1);
    expect(batch.questions[0].expiresAt?.toISOString()).toBe(
      '2026-10-09T10:00:00.000Z',
    );
    expect(batch.refusedQuestions).toEqual([]);
  });

  it('collects the id of a refused question, so the agent can be told', () => {
    const batch = readOutbox(
      lines(
        ask({
          questions: [
            {
              id: 'q',
              prompt: 'Which?',
              options: [{ label: 'A' }, { label: 'A' }],
            },
          ],
        }),
        ask({ id: '../bad' }),
      ),
      PACK,
      newOutboxState(),
    );

    expect(batch.questions).toEqual([]);
    expect(batch.refusedQuestions.map((r) => r.id)).toEqual(['ask-1']);
    expect(batch.rejected).toHaveLength(2);
  });

  it('refuses a sixth question of a run', () => {
    const state = newOutboxState();
    const batch = readOutbox(
      lines(
        ...[1, 2, 3, 4, 5, 6].map((n) => ask({ id: `ask-${n}` })),
      ),
      PACK,
      state,
    );

    expect(batch.questions).toHaveLength(5);
    expect(batch.refusedQuestions.map((r) => r.id)).toEqual(['ask-6']);
  });
});

describe('applying an agent’s outbox', () => {
  const batch = {
    notes: [{ body: 'Found the cause.' }],
    facts: [{ content: 'Rows are paged by 500.', kind: 'FACT', citations: [] }],
    criteria: [],
    questions: [],
    refusedQuestions: [],
    rejected: [],
  } as never;

  function build() {
    const comments = { createIssueComment: jest.fn(async () => ({})) };
    const entries = { createEntry: jest.fn(async () => ({})) };
    const checklist = { updateChecklistItem: jest.fn(async () => ({})) };
    const questions = { create: jest.fn(async () => ({})) };
    const outbox = new RunOutboxService(
      comments as never,
      entries as never,
      checklist as never,
      questions as never,
    );

    return { outbox, comments, entries, checklist, questions };
  }

  const run = {
    id: 'run-1',
    issueId: 'issue-1',
    workspaceId: 'ws-1',
    agentUserId: 'agent-1',
    createdById: 'person-1',
  };
  const empty = {
    notes: [] as unknown[],
    facts: [] as unknown[],
    criteria: [] as unknown[],
    refusedQuestions: [] as unknown[],
    rejected: [] as unknown[],
  };
  const asked = {
    id: 'ask-1',
    questions: [
      {
        id: 'q',
        prompt: 'Use key sk-secret?',
        options: [{ label: 'sk-secret', description: 'the sk-secret key' }],
      },
    ],
  };

  it('removes secrets from a question before it is stored', async () => {
    const { outbox, questions } = build();

    await outbox.apply(
      run,
      { ...empty, questions: [asked] } as never,
      'scope',
      (text) => text.replace(/sk-secret/g, '[secret]'),
    );

    expect(questions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeId: 'person-1',
        questions: [
          {
            id: 'q',
            prompt: 'Use key [secret]?',
            options: [{ label: '[secret]', description: 'the [secret] key' }],
          },
        ],
      }),
    );
  });

  it('reports a question that could not be stored', async () => {
    const { outbox, questions } = build();
    questions.create.mockRejectedValue(new Error('connection lost'));

    const result = await outbox.apply(
      run,
      { ...empty, questions: [asked] } as never,
      'scope',
      (text) => text,
    );

    expect(result.refusedQuestions).toEqual([
      { id: 'ask-1', reason: 'Vantik could not store it' },
    ]);
  });

  it('refuses a question of a run nobody started', async () => {
    const { outbox, questions } = build();

    const result = await outbox.apply(
      { ...run, createdById: null },
      { ...empty, questions: [asked] } as never,
      'scope',
      (text) => text,
    );

    expect(questions.create).not.toHaveBeenCalled();
    expect(result.refusedQuestions?.[0]?.reason).toMatch(/no person/);
  });

  it('writes as the run’s agent and names the run, as before sessions', async () => {
    const { outbox, comments, entries } = build();

    const result = await outbox.apply(
      {
        id: 'run-1',
        issueId: 'issue-1',
        workspaceId: 'ws-1',
        agentUserId: 'agent-1',
      },
      batch,
      'scope',
      (text) => text,
    );

    expect(result.applied).toEqual(['note', 'fact']);
    expect(comments.createIssueComment).toHaveBeenCalledWith(
      { issueId: 'issue-1' },
      'agent-1',
      {
        bodyMarkdown: 'Found the cause.',
        sourceMetadata: { source: 'agent-run-note', agentRunId: 'run-1' },
      },
    );
    expect(entries.createEntry).toHaveBeenCalledWith(
      null,
      { userId: 'agent-1', tokenId: null },
      expect.objectContaining({ sourceSession: 'agent-run:run-1' }),
      'ws-1',
    );
  });

  it('applies the entries of a session that has no run, as its actor on its issue', async () => {
    const { outbox, comments, entries, checklist } = build();
    const session = {
      sessionId: 'session-1',
      issueId: 'issue-2',
      workspaceId: 'ws-1',
      actorUserId: 'user-7',
    };
    const state = newOutboxState();
    state.criteria.set('c1', 'the spec passes');

    const applied = await outbox.apply(session, batch, 'scope', (text) =>
      text.toUpperCase(),
    );
    const ticked = await outbox.tickCriteria(session, state);

    expect(applied.applied).toEqual(['note', 'fact']);
    expect(comments.createIssueComment).toHaveBeenCalledWith(
      { issueId: 'issue-2' },
      'user-7',
      {
        bodyMarkdown: 'FOUND THE CAUSE.',
        sourceMetadata: {
          source: 'agent-session-note',
          agentSessionId: 'session-1',
        },
      },
    );
    expect(entries.createEntry).toHaveBeenCalledWith(
      null,
      { userId: 'user-7', tokenId: null },
      expect.objectContaining({ sourceSession: 'agent-session:session-1' }),
      'ws-1',
    );
    expect(ticked.applied).toEqual(['criterion']);
    expect(checklist.updateChecklistItem).toHaveBeenCalledWith(
      { checklistItemId: 'c1' },
      'user-7',
      { completed: true },
    );
  });

  it('reports a write that fails and goes on with the rest', async () => {
    const { outbox, comments } = build();
    comments.createIssueComment.mockRejectedValueOnce(new Error('no access'));

    const result = await outbox.apply(
      {
        issueId: 'issue-2',
        workspaceId: 'ws-1',
        actorUserId: 'user-7',
        sessionId: 'session-1',
      },
      batch,
      'scope',
      (text) => text,
    );

    expect(result.failed).toEqual(['note: no access']);
    expect(result.applied).toEqual(['fact']);
  });
});
