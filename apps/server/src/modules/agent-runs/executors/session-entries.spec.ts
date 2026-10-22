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

  it('deduplicates mirrored auxiliary usage and counts delegate deltas, not cumulative totals', () => {
    const parsed = parseSessionEntries([
      {
        type: 'message',
        id: 'assistant-1',
        message: {
          role: 'assistant',
          responseId: 'response-1',
          model: 'claude-haiku-5-5',
          usage: { cost: { total: 0.03 }, input: 10, output: 4 },
        },
      },
      {
        type: 'model_usage',
        id: 'usage-1',
        responseId: 'response-1',
        model: 'claude-haiku-5-5',
        usage: { cost: { total: 0.03 }, input: 10, output: 4 },
      },
      {
        type: 'message',
        id: 'delegate-1',
        message: {
          role: 'toolResult',
          details: {
            kind: 'claude-delegate',
            invocationId: 'call-1',
            billing: {
              mode: 'subscription',
              costBasis: 'list',
              apiEquivalentUsd: 0.09,
              deltaApiEquivalentUsd: 0.02,
              cumulative: true,
            },
          },
        },
      },
      {
        type: 'message',
        id: 'unknown-1',
        message: { role: 'assistant', model: 'unknown-model' },
      },
    ]);

    expect(parsed.calls).toHaveLength(3);
    expect(parsed.calls.map((call) => call.costUsd)).toEqual([
      0.03,
      0.02,
      null,
    ]);
    expect(parsed.calls[1]).toMatchObject({
      id: 'delegate:call-1',
      purpose: 'claude_delegate',
      billingMode: 'subscription',
      costBasis: 'list',
    });
    expect(parsed.costUsd).toBeCloseTo(0.05);
  });

  it('names a call the same way wherever it sits in a batch, so a replay names the same call', () => {
    // No id and no response id: only the entry's time and usage name it.
    const bare = {
      type: 'message',
      timestamp: at(7),
      message: {
        role: 'assistant',
        model: 'm',
        usage: { input: 5, output: 2, cost: { total: 0.01 } },
      },
    };

    const alone = parseSessionEntries([bare]).calls.map((call) => call.id);
    const shifted = parseSessionEntries([user(1, 'hi'), bare]).calls.map(
      (call) => call.id,
    );

    expect(alone).toHaveLength(1);
    expect(shifted).toEqual(alone);
  });

  it('keeps the provider, api and response of an auxiliary request, and adds no reasoning to its output', () => {
    const parsed = parseSessionEntries([
      {
        type: 'model_usage',
        id: 'usage-9',
        timestamp: at(3),
        provider: 'vercel',
        api: 'anthropic-messages',
        model: 'm-1',
        purpose: 'title',
        responseId: 'resp-9',
        usage: {
          input: 100,
          output: 20,
          cacheRead: 7,
          cacheWrite: 3,
          reasoning: 50,
          cost: { total: 0.004 },
        },
      },
    ]);

    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]).toMatchObject({
      id: 'response:resp-9',
      purpose: 'auxiliary',
      modelId: 'm-1',
      billingMode: 'metered',
      costBasis: 'harness_estimate',
      costUsd: 0.004,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      provenance: {
        provider: 'vercel',
        api: 'anthropic-messages',
        responseId: 'resp-9',
        auxPurpose: 'title',
      },
    });
    expect(parsed.calls[0].provenance).not.toHaveProperty('reasoning');
  });

  it('reads the pickups and writes of a task, direct and through the write wrapper, and never a read', () => {
    const parsed = parseSessionEntries([
      {
        type: 'message',
        id: 'p1',
        timestamp: at(1),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'c1',
              name: 'mcp__vantik_pick_up_task',
              arguments: { task: 'ENG-42' },
            },
            {
              type: 'toolCall',
              id: 'c2',
              name: 'mcp__vantik_get_task',
              arguments: { task: 'ENG-42' },
            },
            {
              type: 'toolCall',
              id: 'c3',
              name: 'functions.write',
              arguments: {
                path: 'xd://mcp__vantik_update_task',
                content: JSON.stringify({ task: 'ENG-7', state: 'done' }),
              },
            },
            {
              type: 'toolCall',
              id: 'c4',
              name: 'write',
              arguments: { path: 'notes.md', content: '{"task":"ENG-9"}' },
            },
          ],
        },
      },
    ]);

    expect(parsed.tasks).toEqual([
      {
        key: 'entry:p1#0',
        at: new Date(at(1)),
        tool: 'pickup',
        taskRef: 'ENG-42',
      },
      {
        key: 'entry:p1#2',
        at: new Date(at(1)),
        tool: 'write',
        taskRef: 'ENG-7',
      },
    ]);
  });

  it('leaves a delegate result with no known amount unknown, not zero', () => {
    const parsed = parseSessionEntries([
      {
        type: 'message',
        id: 'd9',
        timestamp: at(1),
        message: {
          role: 'toolResult',
          details: {
            kind: 'claude-delegate',
            invocationId: 'inv-9',
            status: 'failed',
            billing: {
              mode: 'subscription',
              costBasis: 'list',
              apiEquivalentUsd: null,
              deltaApiEquivalentUsd: null,
              cumulative: true,
            },
          },
        },
      },
    ]);

    expect(parsed.calls).toEqual([
      expect.objectContaining({
        id: 'delegate:inv-9',
        costUsd: null,
        costBasis: 'unknown',
        billingMode: 'subscription',
      }),
    ]);
    expect(parsed.costUsd).toBe(0);
  });

  it('keeps an external result identity and its cumulative totals, and counts only its delta', () => {
    const parsed = parseSessionEntries([
      {
        type: 'message',
        id: 'd3',
        timestamp: at(4),
        message: {
          role: 'toolResult',
          toolName: 'claude_delegate',
          toolCallId: 'inv-3',
          details: {
            kind: 'claude-delegate',
            invocationId: 'inv-3',
            ompSessionId: 'omp-1',
            claudeSessionId: 'claude-1',
            intent: 'Check the parser',
            requestedModel: 'haiku',
            canonicalModel: 'claude-haiku-5-5',
            actualModels: ['claude-haiku-5-5'],
            status: 'completed',
            resumed: true,
            // Never kept: the result, the permissions and the environment.
            result: { text: 'secret answer' },
            permissions: { write: true },
            env: { TOKEN: 'x' },
            usage: { input: 900, output: 80, cacheRead: 500 },
            modelUsage: {
              'claude-haiku-5-5': {
                provider: 'firstParty',
                costBasis: 'list',
                canonicalModel: 'claude-haiku-5-5',
                inputTokens: 900,
                costUSD: 0.09,
              },
            },
            billing: {
              mode: 'subscription',
              costBasis: 'list',
              apiEquivalentUsd: 0.09,
              deltaApiEquivalentUsd: 0.02,
              cumulative: true,
            },
          },
        },
      },
    ]);

    const call = parsed.calls[0];
    expect(call).toMatchObject({
      id: 'delegate:inv-3',
      modelId: 'claude-haiku-5-5',
      purpose: 'claude_delegate',
      costUsd: 0.02,
      costBasis: 'list',
      billingMode: 'subscription',
    });
    expect(call.provenance.delegate).toMatchObject({
      ompSessionId: 'omp-1',
      claudeSessionId: 'claude-1',
      intent: 'Check the parser',
      requestedModel: 'haiku',
      actualModels: ['claude-haiku-5-5'],
      resumed: true,
      billing: { deltaApiEquivalentUsd: 0.02 },
      cumulativeTotals: {
        apiEquivalentUsd: 0.09,
        usage: { input: 900 },
        modelUsage: { 'claude-haiku-5-5': { inputTokens: 900, costUSD: 0.09 } },
      },
    });
    expect(JSON.stringify(call.provenance)).not.toMatch(
      /secret answer|permissions|TOKEN/,
    );
    // The cumulative totals are not this call's tokens or spend.
    expect(call.inputTokens).toBeUndefined();
    expect(parsed.costUsd).toBeCloseTo(0.02);
  });

  it('keeps a result with no attributable delta unknown, even with an API-equivalent total', () => {
    const parsed = parseSessionEntries([
      {
        type: 'message',
        id: 'd4',
        timestamp: at(5),
        message: {
          role: 'toolResult',
          details: {
            kind: 'claude-delegate',
            invocationId: 'inv-4',
            billing: {
              mode: 'subscription',
              costBasis: 'list',
              apiEquivalentUsd: 0.09,
              cumulative: true,
            },
          },
        },
      },
    ]);

    expect(parsed.calls[0]).toMatchObject({
      costUsd: null,
      costBasis: 'unknown',
    });
    expect(parsed.costUsd).toBe(0);
  });
});
