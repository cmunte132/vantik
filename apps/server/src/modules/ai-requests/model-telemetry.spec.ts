import type { LanguageModelUsage } from 'ai';

import { metrics, trace } from '@opentelemetry/api';
import { metrics as sdkMetrics, node, tracing } from '@opentelemetry/sdk-node';

import { billedCost, startModelTelemetry } from './model-telemetry';

const spans = new tracing.InMemorySpanExporter();
new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(spans)],
}).register();

const reader = new (class extends sdkMetrics.MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
})();
// The instruments come on the first call, so the provider can come after the
// import. This is the order that the test checks.
metrics.setGlobalMeterProvider(
  new sdkMetrics.MeterProvider({ readers: [reader] }),
);

async function metric(name: string) {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((m) => m.descriptor.name === name);
}

const usage: LanguageModelUsage = {
  inputTokens: 1200,
  outputTokens: 300,
  totalTokens: 1500,
  inputTokenDetails: {
    noCacheTokens: 200,
    cacheReadTokens: 1000,
    cacheWriteTokens: undefined,
  },
  outputTokenDetails: { textTokens: 300, reasoningTokens: undefined },
};

describe('model telemetry', () => {
  beforeEach(() => spans.reset());

  it('names the span after the model and records the usage on it', () => {
    const call = startModelTelemetry('triage.pair');
    call.setModel('decisions', 'gemini-3.7-flash');
    call.finish(usage, 'stop');

    const [span] = spans.getFinishedSpans();
    expect(span.name).toBe('chat gemini-3.7-flash');
    expect(span.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gemini-3.7-flash',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 300,
      'gen_ai.usage.cache_read.input_tokens': 1000,
      'gen_ai.response.finish_reasons': ['stop'],
      'vantik.llm.purpose': 'triage.pair',
      'vantik.llm.role': 'decisions',
    });
  });

  it('records the cost the provider billed, summed over the steps', () => {
    const steps = [
      { usage: { raw: { cost: 0.0012, prompt_tokens: 900 } } },
      { usage: { raw: { prompt_tokens: 40 } } },
      { usage: { raw: { cost: 0.0003 } } },
    ];
    const call = startModelTelemetry('triage.pair', 'decisions', 'model-a');
    call.finish(usage, 'stop', 3, billedCost(steps));

    const [span] = spans.getFinishedSpans();
    expect(span.attributes['gen_ai.usage.cost']).toBeCloseTo(0.0015);
  });

  it('records no cost when the provider reports none', () => {
    expect(billedCost([{ usage: { raw: { prompt_tokens: 1 } } }])).toBe(
      undefined,
    );
    expect(billedCost(undefined)).toBe(undefined);

    startModelTelemetry('triage.pair', 'decisions', 'model-a').finish(
      usage,
      'stop',
      1,
      billedCost([{ usage: {} }]),
    );
    const [span] = spans.getFinishedSpans();
    expect(span.attributes['gen_ai.usage.cost']).toBeUndefined();
  });

  it('records the duration and the tokens by purpose, model and type', async () => {
    startModelTelemetry('page.refresh', 'default', 'model-a').finish(
      usage,
      'stop',
    );

    const tokens = await metric('gen_ai.client.token.usage');
    const input = tokens?.dataPoints.find(
      (p) =>
        p.attributes['vantik.llm.purpose'] === 'page.refresh' &&
        p.attributes['gen_ai.token.type'] === 'input',
    );
    expect((input?.value as { sum: number }).sum).toBe(1200);

    const duration = await metric('gen_ai.client.operation.duration');
    expect(
      duration?.dataPoints.some(
        (p) =>
          p.attributes['gen_ai.request.model'] === 'model-a' &&
          p.attributes['error.type'] === undefined,
      ),
    ).toBe(true);
  });

  it('marks a failed call with its error type, and ends the span once', async () => {
    const call = startModelTelemetry('triage.pair', 'decisions', 'model-b');
    const error = new TypeError('fetch failed');
    call.fail(error);
    call.finish(usage, 'stop');

    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0].status.code).toBe(2);
    expect(finished[0].attributes['error.type']).toBe('TypeError');

    const duration = await metric('gen_ai.client.operation.duration');
    expect(
      duration?.dataPoints.some(
        (p) =>
          p.attributes['gen_ai.request.model'] === 'model-b' &&
          p.attributes['error.type'] === 'TypeError',
      ),
    ).toBe(true);
  });

  it('makes the span the parent of the work inside run()', () => {
    const call = startModelTelemetry('issues.title', 'default', 'model-c');
    call.run(() => trace.getTracer('test').startSpan('POST').end());
    call.finish(undefined, 'stop');

    const [http, model] = spans.getFinishedSpans();
    expect(http.parentSpanContext?.spanId).toBe(model.spanContext().spanId);
  });

  it('names a call with no model yet after its purpose', () => {
    startModelTelemetry('issues.summary').fail(new Error('no model'));

    expect(spans.getFinishedSpans()[0].name).toBe('chat issues.summary');
  });
});
