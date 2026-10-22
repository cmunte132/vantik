import {
  CONSERVE_AT,
  createQuotaCache,
  explicitOutcomeRecord,
  FRESH_MS,
  nativeOutcomeRecords,
  OUTCOME_ENTRY,
  type RoutingContext,
  type OutcomeRecord,
  type RoutingHandler,
  type RoutingPi,
  type RoutingTool,
  registerDelegationRouting,
  ROUTING_MARK,
  summarizeQuota,
  withRoutingPolicy,
} from './delegation-routing';

const NOW = Date.parse('2026-10-21T12:00:00Z');

/** A fresh, unreset Codex row. Override any field per case. */
function row(over: Record<string, unknown> = {}) {
  return {
    recordedAt: NOW - 60_000,
    provider: 'openai-codex',
    accountKey: 'acct-a',
    limitId: 'openai-codex:primary',
    usedFraction: 0.2,
    status: 'ok',
    resetsAt: NOW + 3_600_000,
    ...over,
  };
}

/** Primary and secondary rows for one account, sharing the overrides. */
function pair(over: Record<string, unknown> = {}) {
  return [
    row({ limitId: 'openai-codex:primary', ...over }),
    row({ limitId: 'openai-codex:secondary', ...over }),
  ];
}

function stateOf(rows: unknown[]) {
  return summarizeQuota(rows, NOW).state;
}

function fakePi() {
  const handlers = new Map<string, RoutingHandler>();
  const entries: Array<{ type: string; data: OutcomeRecord }> = [];
  const tools: RoutingTool[] = [];
  const pi: RoutingPi = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    registerTool: (tool) => {
      tools.push(tool);
    },
    appendEntry: (type, data) => {
      entries.push({ type, data });
    },
  };
  return { pi, handlers, entries, tools };
}

function ctxWith(
  rows: unknown,
  extra: Partial<RoutingContext> = {},
): RoutingContext {
  return {
    modelRegistry: {
      authStorage: { usage: { history: () => rows } },
    },
    ...extra,
  };
}

describe('quota pressure from native history', () => {
  it('is normal for a fresh account with both windows well under the threshold', () => {
    expect(stateOf(pair())).toBe('normal');
  });

  it('is unknown when one of the two base windows is missing', () => {
    expect(stateOf([row({ limitId: 'openai-codex:primary' })])).toBe('unknown');
  });

  it('is unknown when the history has no Codex rows at all', () => {
    expect(stateOf([])).toBe('unknown');
  });

  it('accepts a row exactly at the freshness limit and rejects one past it', () => {
    expect(stateOf(pair({ recordedAt: NOW - FRESH_MS }))).toBe('normal');
    expect(stateOf(pair({ recordedAt: NOW - FRESH_MS - 1 }))).toBe('unknown');
  });

  it('treats a row from the future as invalid, not fresh', () => {
    expect(stateOf(pair({ recordedAt: NOW + 1 }))).toBe('unknown');
  });

  it('treats an elapsed reset as unknown until a fresh row replaces it', () => {
    expect(stateOf(pair({ resetsAt: NOW }))).toBe('unknown');
    expect(stateOf(pair({ resetsAt: NOW + 1 }))).toBe('normal');
  });

  it('turns conserve on at the 80% boundary and not just below it', () => {
    expect(CONSERVE_AT).toBe(0.8);
    expect(stateOf(pair({ usedFraction: 0.79 }))).toBe('normal');
    expect(stateOf(pair({ usedFraction: 0.8 }))).toBe('conserve');
  });

  it('treats a native warning as conserve even at low usage', () => {
    expect(stateOf(pair({ status: 'warning', usedFraction: 0.1 }))).toBe(
      'conserve',
    );
  });

  it('treats a native exhausted status as exhausted', () => {
    expect(stateOf(pair({ status: 'exhausted', usedFraction: 1 }))).toBe(
      'exhausted',
    );
  });

  it('does not call a window exhausted from 100% alone, since credits may still pass', () => {
    expect(stateOf(pair({ usedFraction: 1 }))).toBe('conserve');
  });

  it('does not treat a missing fraction as zero', () => {
    expect(stateOf(pair({ usedFraction: undefined }))).toBe('unknown');
  });

  it('ignores Spark and other feature meters entirely', () => {
    const spark = row({
      limitId: 'openai-codex:spark:primary',
      status: 'exhausted',
      usedFraction: 1,
    });
    const snapshot = summarizeQuota([...pair(), spark], NOW);
    expect(snapshot.state).toBe('normal');
    expect(snapshot.accounts).toHaveLength(1);
  });

  it('uses only the latest row per account and limit', () => {
    const older = row({
      recordedAt: NOW - 10 * 60_000,
      status: 'exhausted',
      usedFraction: 1,
    });
    expect(stateOf([older, ...pair()])).toBe('normal');
  });

  it('is unknown with two accounts that disagree, and never assumes the worst one', () => {
    const snapshot = summarizeQuota(
      [
        ...pair({ accountKey: 'acct-a' }),
        ...pair({ accountKey: 'acct-b', usedFraction: 0.9 }),
      ],
      NOW,
    );
    expect(snapshot.accounts.map((account) => account.state)).toEqual([
      'normal',
      'conserve',
    ]);
    expect(snapshot.state).toBe('unknown');
  });

  it('keeps the overall state when every account agrees', () => {
    const snapshot = summarizeQuota(
      [...pair({ accountKey: 'acct-a' }), ...pair({ accountKey: 'acct-b' })],
      NOW,
    );
    expect(snapshot.state).toBe('normal');
  });

  it('reports accounts without any account key', () => {
    const snapshot = summarizeQuota(
      [...pair({ accountKey: 'secret-key-123' })],
      NOW,
    );
    expect(JSON.stringify(snapshot)).not.toContain('secret-key-123');
  });
});

describe('quota cache and history reads', () => {
  it('is unknown when the history is absent, throws, or is malformed', async () => {
    const now = () => NOW;
    const cache = createQuotaCache(now);
    const absent = await cache.current({});
    expect(absent.state).toBe('unknown');

    const throwing = await createQuotaCache(now).current(
      ctxWith(undefined, {
        modelRegistry: {
          authStorage: {
            usage: {
              history: () => {
                throw new Error('boom');
              },
            },
          },
        },
      }),
    );
    expect(throwing.state).toBe('unknown');

    const malformed = await createQuotaCache(now).current(
      ctxWith({ not: 'an array' }),
    );
    expect(malformed.state).toBe('unknown');
  });

  it('reuses the cached snapshot inside the TTL and reads again after it', async () => {
    let at = NOW;
    let reads = 0;
    const ctx = ctxWith(undefined, {
      modelRegistry: {
        authStorage: {
          usage: {
            history: () => {
              reads += 1;
              return pair();
            },
          },
        },
      },
    });
    const cache = createQuotaCache(() => at, 60_000);
    await cache.current(ctx);
    at = NOW + 59_999;
    await cache.current(ctx);
    expect(reads).toBe(1);
    at = NOW + 60_000;
    await cache.current(ctx);
    expect(reads).toBe(2);
  });
});

describe('system prompt routing block', () => {
  it('keeps every existing block and appends one routing block', () => {
    const base = ['first block', 'second block'];
    const next = withRoutingPolicy(base, 'normal');
    expect(next.slice(0, 2)).toEqual(base);
    expect(next).toHaveLength(3);
    expect(String(next[2]).startsWith(ROUTING_MARK)).toBe(true);
  });

  it('replaces the routing block from an earlier turn instead of stacking it', () => {
    const once = withRoutingPolicy(['base'], 'normal');
    const again = withRoutingPolicy(once as string[], 'conserve');
    expect(again).toHaveLength(2);
    expect(String(again[1])).toContain('conserve');
  });
});

describe('outcome records', () => {
  it('records a completed native task as not assessed, not verified', () => {
    const [record] = nativeOutcomeRecords(
      {
        toolName: 'task',
        toolCallId: 'call-1',
        isError: false,
        details: {
          results: [
            { agent: 'worker', status: 'completed', resolvedModel: 'm-1' },
          ],
        },
      },
      NOW,
    );
    expect(record.assessment).toBe('not-assessed');
    expect(record.reportedStatus).toBe('completed');
    expect(record.resolvedModel).toBe('m-1');
  });

  it('records a failed claude_delegate run with its reported status', () => {
    const [record] = nativeOutcomeRecords(
      {
        toolName: 'claude_delegate',
        toolCallId: 'call-2',
        isError: true,
        details: {
          invocationId: 'call-2',
          intent: 'execution',
          requestedModel: 'claude-haiku-5-5',
          modelSelection: 'default',
          actualModels: ['claude-haiku-5-5'],
          status: 'failed',
          usage: { input_tokens: 10, output_tokens: 4, nested: { a: 1 } },
          result: 'a reply that must not be copied',
        },
      },
      NOW,
    );
    expect(record.assessment).toBe('not-assessed');
    expect(record.isError).toBe(true);
    expect(record.reportedStatus).toBe('failed');
    expect(record.route).toBe('claude-cli');
    expect(record.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
    expect(JSON.stringify(record)).not.toContain(
      'a reply that must not be copied',
    );
  });

  it('ignores other tools', () => {
    expect(
      nativeOutcomeRecords(
        { toolName: 'bash', toolCallId: 'x', details: {} },
        NOW,
      ),
    ).toEqual([]);
  });

  it('appends each native record once when the same callback repeats', () => {
    const { pi, handlers, entries } = fakePi();
    registerDelegationRouting(pi, { now: () => NOW });
    const event = {
      toolName: 'task',
      toolCallId: 'call-3',
      details: { results: [{ status: 'completed' }] },
    };
    handlers.get('tool_result')!(event, ctxWith(undefined));
    handlers.get('tool_result')!(event, ctxWith(undefined));
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe(OUTCOME_ENTRY);
  });

  it('records an explicit outcome with the primary assessment and its evidence', () => {
    const record = explicitOutcomeRecord(
      {
        invocationId: 'inv-1',
        outcome: 'needs_rework',
        reason: 'The test still fails.',
        evidence: ['src/a.spec.ts'],
      },
      'call-9',
      NOW,
    );
    expect(record.source).toBe('primary');
    expect(record.assessment).toBe('needs_rework');
    expect(record.evidence).toEqual(['src/a.spec.ts']);
  });

  it('rejects an unknown outcome and a missing reason', () => {
    expect(() =>
      explicitOutcomeRecord(
        { invocationId: 'i', outcome: 'accepted', reason: 'r' },
        'c',
        NOW,
      ),
    ).toThrow();
    expect(() =>
      explicitOutcomeRecord(
        { invocationId: 'i', outcome: 'failed', reason: '  ' },
        'c',
        NOW,
      ),
    ).toThrow();
  });

  it('does not record the same delegation_outcome call twice', async () => {
    const { pi, tools, entries } = fakePi();
    registerDelegationRouting(pi, { now: () => NOW });
    const tool = tools.find((t) => t.name === 'delegation_outcome');
    const params = {
      invocationId: 'inv-2',
      outcome: 'verified',
      reason: 'checked',
    };
    const first = await tool.execute(
      'call-10',
      params,
      undefined,
      undefined,
      {},
    );
    const second = await tool.execute(
      'call-10',
      params,
      undefined,
      undefined,
      {},
    );
    expect(first.details.recorded).toBe(true);
    expect(second.details.recorded).toBe(false);
    expect(entries).toHaveLength(1);
  });
});
