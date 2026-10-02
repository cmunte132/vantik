import { PiEventReader, parsePiEvents } from './pi-events';

/** One event per line, the way Pi's `--mode json` writes them. */
function stream(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

describe('reading a run out of Pi’s event stream', () => {
  it('turns a tool call into a step that says what it acted on', () => {
    const { steps } = parsePiEvents(
      stream({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'read',
        args: { path: 'apps/server/src/thing.ts' },
      }),
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]?.message).toBe('read: apps/server/src/thing.ts');
    expect(steps[0]?.data).toMatchObject({
      kind: 'read',
      ref: 'call-1',
      target: 'apps/server/src/thing.ts',
    });
  });

  it('calls a test run a test, from the shape of the command', () => {
    // Not by comparing against the configured test command: an agent runs one
    // suite, one file and one case, and only the first would ever match.
    const { steps } = parsePiEvents(
      stream({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'pnpm jest repo-routing' },
      }),
    );

    expect(steps[0]?.data).toMatchObject({
      kind: 'test',
      command: 'pnpm jest repo-routing',
    });
  });

  it('keeps a failing step’s output and its exit code', () => {
    // The one place output is worth storing. A step that worked has already
    // been reported by its start event.
    const { steps } = parsePiEvents(
      stream({
        type: 'tool_execution_end',
        toolName: 'bash',
        isError: true,
        result: { text: 'boom\nCommand exited with code 2' },
      }),
    );

    expect(steps[0]?.level).toBe('ERROR');
    expect(steps[0]?.data).toMatchObject({ ok: false, exit: 2 });
    expect(String(steps[0]?.data?.output)).toContain('boom');
  });

  it('reports a pass count when the output stated one', () => {
    const { steps } = parsePiEvents(
      stream({
        type: 'tool_execution_end',
        toolName: 'bash',
        isError: false,
        result: { text: 'Tests: 6 passed, 1 failed' },
      }),
    );

    expect(steps[0]?.message).toBe('Tests passed: 6');
    expect(steps[0]?.data).toMatchObject({ passed: 6, failed: 1 });
  });

  it('says nothing about a turn ending, but counts it', () => {
    // Pi emits one after every tool call. Logging them is what made an earlier
    // run's history forty lines of "Finished a turn".
    const { steps, iterations } = parsePiEvents(
      stream({ type: 'turn_end' }, { type: 'turn_end' }),
    );

    expect(steps).toHaveLength(0);
    expect(iterations).toBe(2);
  });

  it('keeps what the agent said between tool calls as a note', () => {
    const { steps } = parsePiEvents(
      stream({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'The model has no updatedAt.\nI will read createdAt.',
            },
            { type: 'toolCall', name: 'read' },
          ],
        },
      }),
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]?.message).toBe('The model has no updatedAt.');
    expect(steps[0]?.data).toEqual({
      kind: 'note',
      text: 'The model has no updatedAt.\nI will read createdAt.',
    });
  });

  it('writes no note for a message that only called a tool', () => {
    const { steps } = parsePiEvents(
      stream({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'toolCall' }] },
      }),
    );

    expect(steps).toHaveLength(0);
  });

  it('counts the lines of a new file', () => {
    const { steps } = parsePiEvents(
      stream({
        type: 'tool_execution_start',
        toolCallId: 'call-2',
        toolName: 'write',
        args: { path: 'a.ts', content: 'one\ntwo\nthree\n' },
      }),
    );

    expect(steps[0]?.data).toMatchObject({
      kind: 'write',
      target: 'a.ts',
      added: 3,
    });
  });

  it('keeps an edit’s diff, counted and without line numbers', () => {
    const { steps } = parsePiEvents(
      stream({
        type: 'tool_execution_end',
        toolCallId: 'call-3',
        toolName: 'edit',
        isError: false,
        result: {
          content: [{ type: 'text', text: 'Successfully replaced 1 block.' }],
          details: {
            diff: [
              '  9 function changedSince() {',
              '-10   const where = { updatedAt };',
              '+10   const column = changeColumnOf(model);',
              '+11   const where = { [column]: since };',
              '   ...',
            ].join('\n'),
          },
        },
      }),
    );

    expect(steps[0]?.data).toEqual({
      kind: 'write',
      ref: 'call-3',
      ok: true,
      added: 2,
      removed: 1,
      diff: [
        ' function changedSince() {',
        '-  const where = { updatedAt };',
        '+  const column = changeColumnOf(model);',
        '+  const where = { [column]: since };',
        ' …',
      ].join('\n'),
    });
  });

  it('caps a long diff but still counts all of it', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `+${i + 1} line ${i}`);
    const { steps } = parsePiEvents(
      stream({
        type: 'tool_execution_end',
        toolName: 'edit',
        isError: false,
        result: { details: { diff: lines.join('\n') } },
      }),
    );

    expect(steps[0]?.data?.added).toBe(100);
    expect(String(steps[0]?.data?.diff).split('\n')).toHaveLength(40);
  });

  it('takes the agent’s last message as the summary', () => {
    // Earlier messages are narration between tool calls. The closing report is
    // the thing a reviewer came to read.
    const { summary } = parsePiEvents(
      stream(
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Looking at the importer now.' }],
          },
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '1. met — covered by importer.spec' },
            ],
          },
        },
      ),
    );

    expect(summary).toBe('1. met — covered by importer.spec');
  });

  it('ignores a user message when looking for what the agent said', () => {
    const { summary } = parsePiEvents(
      stream({
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'the prompt' }],
        },
      }),
    );

    expect(summary).toBeNull();
  });

  it('records the model that actually answered', () => {
    // `--model` is a pattern Pi resolves against what the provider offers, so
    // the id that ran is not always the id that was asked for.
    const { modelId } = parsePiEvents(
      stream({
        type: 'message_end',
        message: {
          role: 'assistant',
          model: 'google/gemini-3.6-flash',
          content: [],
        },
      }),
    );

    expect(modelId).toBe('google/gemini-3.6-flash');
  });

  it('adds up what the run cost', () => {
    const { costUsd } = parsePiEvents(
      stream(
        {
          type: 'message_end',
          message: { role: 'assistant', usage: { cost: { total: 0.02 } } },
        },
        {
          type: 'message_end',
          message: { role: 'assistant', usage: { cost: { total: 0.03 } } },
        },
      ),
    );

    expect(costUsd).toBeCloseTo(0.05);
  });

  it('counts each call once, though Pi repeats its message on other events', () => {
    const message = { role: 'assistant', usage: { cost: { total: 0.02 } } };
    const { costUsd } = parsePiEvents(
      stream(
        { type: 'message_start', message },
        { type: 'message_update', message },
        { type: 'message_update', message },
        { type: 'message_end', message },
        { type: 'turn_end', message },
        {
          type: 'message_end',
          message: { role: 'toolResult', usage: { cost: { total: 0.02 } } },
        },
      ),
    );

    expect(costUsd).toBeCloseTo(0.02);
  });

  it('survives a stream that was truncated or has prose in it', () => {
    // The sandbox caps stdout, so the first record of a long run is routinely
    // half a line. Losing the whole history to a formatting complaint would be
    // the worst possible trade.
    const { steps, summary } = parsePiEvents(
      [
        'olName": "read"}',
        'npm warn exec the following package was not found locally',
        JSON.stringify({
          type: 'tool_execution_start',
          toolName: 'write',
          args: { path: 'a.ts' },
        }),
        '{"type": "message_end", "message": {"role": "assist',
      ].join('\n'),
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]?.data).toMatchObject({ kind: 'write' });
    expect(summary).toBeNull();
  });

  it('reads an empty stream as a run that did nothing', () => {
    expect(parsePiEvents('')).toEqual({
      steps: [],
      summary: null,
      modelId: null,
      costUsd: 0,
      iterations: 0,
      failure: null,
    });
  });
});

/**
 * The harness exits zero when the provider refuses it, so a run that never
 * reached a model is indistinguishable from one that finished quietly unless
 * these two fields are read. Shapes taken from real streams: a 400 for an
 * unknown model id and a 401 for a rejected key.
 */
describe('a model call that never answered', () => {
  const errored = (errorMessage: string) => ({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [] as unknown[],
      provider: 'openrouter',
      model: 'google/gemini-3.7-flash',
      stopReason: 'error',
      errorMessage,
    },
  });

  const answered = (text: string) => ({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'google/gemini-3.7-flash',
      stopReason: 'stop',
    },
  });

  it('reports the provider’s refusal of an unknown model id', () => {
    const { failure } = parsePiEvents(
      stream(
        errored(
          '400: {"message":"google/gemini-nope is not a valid model ID","code":400}',
        ),
      ),
    );

    expect(failure?.reason).toBe('error');
    expect(failure?.message).toContain('is not a valid model ID');
  });

  it('reports a key the provider would not take', () => {
    const { failure } = parsePiEvents(
      stream(errored('401: {"message":"Missing Authentication header"}')),
    );

    expect(failure?.message).toContain('Missing Authentication header');
  });

  it('says nothing about a run that ended normally', () => {
    expect(parsePiEvents(stream(answered('Done.'))).failure).toBeNull();
  });

  // Pi retries a failed call. Failing the run on an error it recovered from
  // would throw away everything the retry went on to do.
  it('ignores an error a later message recovered from', () => {
    const { failure, summary } = parsePiEvents(
      stream(errored('429: rate limited'), answered('Done anyway.')),
    );

    expect(failure).toBeNull();
    expect(summary).toBe('Done anyway.');
  });

  it('still reports a failure the harness gave no reason for', () => {
    const { failure } = parsePiEvents(
      stream({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'error' },
      }),
    );

    expect(failure?.message).toContain('did not say why');
  });
});

/**
 * The sandbox hands stdout over in chunks as the harness writes it, and a
 * chunk ends wherever the pipe happened to flush, often inside a line.
 */
describe('reading Pi’s event stream as it arrives', () => {
  const lines = [
    stream({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'src/a.ts' },
    }),
    stream({
      type: 'tool_execution_start',
      toolCallId: 'call-2',
      toolName: 'read',
      args: { path: 'src/b.ts' },
    }),
  ].join('\n');

  it('gives a step only once its line is complete', () => {
    const reader = new PiEventReader();
    const cut = lines.indexOf('src/b.ts');

    expect(reader.push(lines.slice(0, 10))).toEqual([]);
    expect(
      reader.push(lines.slice(10, cut)).map((step) => step.message),
    ).toEqual(['read: src/a.ts']);
    expect(reader.push(lines.slice(cut))).toEqual([]);
    expect(reader.flush().map((step) => step.message)).toEqual([
      'read: src/b.ts',
    ]);
  });

  it('reads the same run whatever the chunks were', () => {
    const reader = new PiEventReader();

    for (const character of lines) {
      reader.push(character);
    }
    reader.flush();

    expect(reader.result()).toEqual(parsePiEvents(lines));
  });

  it('drops a line broken by lost output rather than joining two halves', () => {
    const reader = new PiEventReader();
    const [first, second] = lines.split('\n');

    reader.push(first!.slice(0, 20));
    // The runtime marks the gap with an LF; the rest of the lost line follows.
    const steps = [
      ...reader.push(`\n${second!.slice(5)}\n`),
      ...reader.push(`${second}\n`),
    ];

    expect(steps.map((step) => step.message)).toEqual(['read: src/b.ts']);
  });
});
