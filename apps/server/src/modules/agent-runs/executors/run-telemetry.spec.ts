import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { tracing } from '@opentelemetry/sdk-node';

import { PiEventReader } from './pi-events';
import { recordRunFinished, startRunTelemetry } from './run-telemetry';

const spans = new tracing.InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});

beforeAll(() => {
  trace.setGlobalTracerProvider(
    new tracing.BasicTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(spans)],
    }),
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});

beforeEach(() => spans.reset());

async function metric(name: string) {
  await reader.forceFlush();
  const all = metricExporter
    .getMetrics()
    .flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
  return all.filter((m) => m.descriptor.name === name).pop();
}

const line = (event: object) => `${JSON.stringify(event)}\n`;

describe('run telemetry', () => {
  it('traces a run as phases holding its model and tool calls', async () => {
    const telemetry = startRunTelemetry({
      runId: 'run-1',
      issueId: 'issue-1',
      agentUserId: 'agent-1',
      executor: 'hosted',
      provider: 'openrouter',
      model: '~anthropic/claude-sonnet-latest',
    });

    telemetry.phase('setup');
    telemetry.phase('implement');

    const pi = new PiEventReader((event) => telemetry.observe(event));
    const message = {
      role: 'assistant',
      model: 'anthropic/claude-sonnet-5',
      stopReason: 'toolUse',
      usage: {
        input: 1200,
        output: 80,
        cacheRead: 900,
        cost: { total: 0.004 },
      },
    };
    pi.push(
      line({ type: 'message_start', message }) +
        line({ type: 'message_update', message }) +
        line({ type: 'message_end', message }) +
        line({ type: 'turn_end', message }) +
        line({
          type: 'tool_execution_start',
          toolCallId: 't1',
          toolName: 'bash',
          args: { command: 'ls' },
        }) +
        line({
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'bash',
          isError: true,
          result: 'nope',
        }),
    );

    telemetry.end({
      status: 'FAILED',
      failure: 'HARNESS_CRASHED',
      error: 'boom',
    });
    // A second end, as `finally` does after `fail`, changes nothing.
    telemetry.end({ status: 'ENDED_ELSEWHERE' });

    const finished = spans.getFinishedSpans();
    const byName = (name: string) => finished.filter((s) => s.name === name);

    const [root] = byName('invoke_agent hosted');
    expect(byName('invoke_agent hosted')).toHaveLength(1);
    expect(root.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(root.attributes['gen_ai.provider.name']).toBe('openrouter');
    expect(root.attributes['vantik.agent_run.failure']).toBe('HARNESS_CRASHED');
    expect(root.status.code).toBe(SpanStatusCode.ERROR);

    const rootId = root.spanContext().spanId;
    const phases = finished.filter((s) => s.name.startsWith('agent_phase'));
    expect(phases.map((s) => s.name)).toEqual([
      'agent_phase setup',
      'agent_phase implement',
    ]);
    for (const phase of phases) {
      expect(phase.parentSpanContext?.spanId).toBe(rootId);
    }
    const implementId = phases[1].spanContext().spanId;

    const chats = finished.filter((s) => s.name.startsWith('chat '));
    expect(chats).toHaveLength(1);
    expect(chats[0].parentSpanContext?.spanId).toBe(implementId);
    expect(chats[0].attributes['gen_ai.usage.input_tokens']).toBe(1200);
    expect(chats[0].attributes['gen_ai.response.model']).toBe(
      'anthropic/claude-sonnet-5',
    );

    const [tool] = byName('execute_tool bash');
    expect(tool.parentSpanContext?.spanId).toBe(implementId);
    expect(tool.attributes['gen_ai.tool.call.id']).toBe('t1');
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);

    const tokens = await metric('gen_ai.client.token.usage');
    const points = tokens?.dataPoints ?? [];
    const input = points.find(
      (p) =>
        p.attributes['gen_ai.token.type'] === 'input' &&
        p.attributes['vantik.llm.purpose'] === 'agent_run',
    );
    expect(input?.attributes['vantik.llm.role']).toBe('implement');
    expect((input?.value as { sum: number }).sum).toBe(1200);
  });

  it('ends model and tool calls the phase left open', () => {
    const telemetry = startRunTelemetry({
      runId: 'run-2',
      issueId: 'issue-1',
      agentUserId: 'agent-1',
      executor: 'hosted',
    });

    telemetry.phase('implement');
    telemetry.observe({
      type: 'message_start',
      message: { role: 'assistant' },
    });
    telemetry.observe({
      type: 'tool_execution_start',
      toolCallId: 'x',
      toolName: 'read',
    });
    telemetry.phase('verify');
    telemetry.end({ status: 'SUCCEEDED' });

    const names = spans.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'chat unknown',
        'execute_tool read',
        'agent_phase implement',
        'agent_phase verify',
        'invoke_agent hosted',
      ]),
    );
  });

  it('counts a finished run with its duration, cost and turns', async () => {
    recordRunFinished({
      executor: 'hosted',
      status: 'SUCCEEDED',
      failure: null,
      createdAt: new Date('2026-10-02T10:00:00Z'),
      claimedAt: new Date('2026-10-02T10:00:10Z'),
      finishedAt: new Date('2026-10-02T10:05:10Z'),
      iterationCount: 3,
      result: { costUsd: 0.168, turns: 12 },
    });

    const finished = await metric('vantik.agent_run.finished');
    const point = finished?.dataPoints.find(
      (p) => p.attributes['vantik.agent_run.status'] === 'SUCCEEDED',
    );
    expect(point?.value).toBe(1);
    expect(point?.attributes['vantik.agent_run.failure']).toBe('none');

    const duration = await metric('vantik.agent_run.duration');
    expect((duration?.dataPoints[0].value as { sum: number }).sum).toBe(300);
    const cost = await metric('vantik.agent_run.cost');
    expect((cost?.dataPoints[0].value as { sum: number }).sum).toBeCloseTo(
      0.168,
    );
    const turns = await metric('vantik.agent_run.turns');
    expect((turns?.dataPoints[0].value as { sum: number }).sum).toBe(12);
  });
});
