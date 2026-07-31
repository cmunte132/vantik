import { parsePiEvents } from './pi-events';

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
        { type: 'message_end', message: { usage: { cost: { total: 0.02 } } } },
        { type: 'message_end', message: { usage: { cost: { total: 0.03 } } } },
      ),
    );

    expect(costUsd).toBeCloseTo(0.05);
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
    });
  });
});
