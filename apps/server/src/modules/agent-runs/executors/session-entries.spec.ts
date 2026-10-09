/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ParsedStep, parsePiEvents } from './pi-events';
import { parseSessionEntries } from './session-entries';

const at = (second: number) =>
  `2026-10-09T10:00:${String(second).padStart(2, '0')}.000Z`;

const user = (second: number, text: string) => ({
  type: 'message',
  id: `u${second}`,
  timestamp: at(second),
  message: {
    role: 'user',
    attribution: 'user',
    content: [{ type: 'text', text }],
  },
});

const assistant = (second: number, content: unknown[], cost = 0.01) => ({
  type: 'message',
  id: `a${second}`,
  timestamp: at(second),
  message: {
    role: 'assistant',
    model: 'gpt-6.1-sol',
    content,
    usage: { cost: { total: cost } },
    stopReason: 'toolUse',
  },
});

const toolResult = (
  second: number,
  id: string,
  name: string,
  text: string,
  isError = false,
) => ({
  type: 'message',
  id: `t${second}`,
  timestamp: at(second),
  message: {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    isError,
    content: [{ type: 'text', text }],
  },
});

describe('parseSessionEntries', () => {
  const entries: Array<Record<string, any>> = [
    {
      type: 'model_change',
      timestamp: at(0),
      model: 'openai-codex/gpt-6.1-sol',
    },
    user(1, 'Please rename the heading\nand run the tests'),
    assistant(2, [
      { type: 'text', text: 'Looking at the README first.' },
      {
        type: 'toolCall',
        id: 'c1',
        name: 'read',
        arguments: { path: 'README.md' },
      },
    ]),
    toolResult(3, 'c1', 'read', 'contents'),
    assistant(4, [
      {
        type: 'toolCall',
        id: 'c2',
        name: 'bash',
        arguments: { command: 'pnpm test' },
      },
    ]),
    toolResult(5, 'c2', 'bash', 'Command exited with code 1', true),
  ];

  it('turns messages into the steps a run would have', () => {
    const parsed = parseSessionEntries(entries);

    expect(parsed.steps.map((step) => step.message)).toEqual([
      'Please rename the heading',
      'Looking at the README first.',
      'read: README.md',
      'bash: pnpm test',
      'bash failed',
    ]);
    expect(parsed.steps[0].data).toMatchObject({ kind: 'note', role: 'user' });
    expect(parsed.steps[2].data).toMatchObject({
      kind: 'read',
      target: 'README.md',
      ref: 'c1',
    });
    expect(parsed.steps[4]).toMatchObject({
      level: 'ERROR',
      data: { kind: 'bash', ok: false, exit: 1 },
    });
  });

  it('stamps each step with its entry time and totals turns and cost', () => {
    const parsed = parseSessionEntries(entries);

    expect(parsed.steps[1].at.toISOString()).toBe(at(2));
    expect(parsed.steps[4].at.toISOString()).toBe(at(5));
    expect(parsed.lastAt?.toISOString()).toBe(at(5));
    expect(parsed.turns).toBe(2);
    expect(parsed.costUsd).toBeCloseTo(0.02);
    expect(parsed.modelId).toBe('gpt-6.1-sol');
  });

  it('gives the same steps as the event stream of a run for the same work', () => {
    const run = parsePiEvents(
      [
        { type: 'message_end', message: entries[2]?.message },
        {
          type: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'c1',
          args: { path: 'README.md' },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    );
    const parsed = parseSessionEntries(entries.slice(2, 3));

    const bare = (steps: ParsedStep[]) =>
      steps.map(({ message, level, phase, data }) => ({
        message,
        level,
        phase,
        data,
      }));

    expect(bare(parsed.steps)).toEqual(bare(run.steps));
  });

  it('skips what it cannot read, and a message omp wrote itself', () => {
    const parsed = parseSessionEntries([
      null,
      'text',
      {
        type: 'message',
        message: { role: 'user', attribution: 'agent', content: 'x' },
      },
      { type: 'custom', data: {} },
      { type: 'message', message: { role: 'mystery' } },
    ]);

    expect(parsed.steps).toEqual([]);
    expect(parsed.turns).toBe(0);
  });
});
