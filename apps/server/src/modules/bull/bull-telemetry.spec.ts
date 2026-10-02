import { context, metrics, trace } from '@opentelemetry/api';
import { metrics as sdkMetrics, node, tracing } from '@opentelemetry/sdk-node';
import Queue from 'bull';

// The patch keeps the Job.create that it finds when it loads. Replace it
// first, so that a test can see the options without Redis.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Job = require('bull/lib/job');
const create = jest.fn((...args: unknown[]) => Promise.resolve(args));
const createBulk = jest.fn((...args: unknown[]) => Promise.resolve(args));
Job.create = create;
Job.createBulk = createBulk;

const spans = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(spans)],
});
provider.register();

const reader = new (class extends sdkMetrics.MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
})();
metrics.setGlobalMeterProvider(
  new sdkMetrics.MeterProvider({ readers: [reader] }),
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('./bull-telemetry');

type Processor = (job: Partial<Queue.Job>) => Promise<unknown>;

/** A queue with only the fields that setHandler and the gauge read. */
function fakeQueue(name: string) {
  return {
    name,
    handlers: {} as Record<string, Processor>,
    setWorkerName() {},
    getJobCounts: async () => ({
      waiting: 3,
      active: 1,
      delayed: 0,
      failed: 2,
      paused: 0,
      completed: 40,
    }),
  };
}

function register(queue: ReturnType<typeof fakeQueue>, handler: Processor) {
  (
    Queue.prototype as unknown as {
      setHandler(name: string, handler: unknown): void;
    }
  ).setHandler.call(queue, '__default__', handler);
  return queue.handlers['__default__'];
}

function job(overrides: Partial<Queue.Job> = {}): Partial<Queue.Job> {
  return {
    id: 7,
    name: '__default__',
    timestamp: Date.now() - 1500,
    attemptsMade: 0,
    opts: {},
    ...overrides,
  };
}

async function collect() {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
}

describe('bull telemetry', () => {
  beforeEach(() => spans.reset());

  it('runs each job inside a consumer span and returns its result', async () => {
    const queue = fakeQueue('notifications');
    const run = register(queue, async () => 'sent');

    await expect(run(job())).resolves.toBe('sent');

    const [span] = spans.getFinishedSpans();
    expect(span.name).toBe('process notifications');
    expect(span.attributes['messaging.destination.name']).toBe('notifications');
    expect(span.attributes['vantik.queue.attempt']).toBe(1);
  });

  it('marks the span as an error and rethrows when the job fails', async () => {
    const run = register(fakeQueue('pages'), async () => {
      throw new Error('boom');
    });

    await expect(run(job())).rejects.toThrow('boom');

    const [span] = spans.getFinishedSpans();
    expect(span.status.code).toBe(2);
    expect(span.events[0].name).toBe('exception');
  });

  it('records duration by outcome, wait time and queue depth', async () => {
    const run = register(fakeQueue('cycles'), async () => 'ok');
    await run(job());

    const all = await collect();
    const duration = all.find(
      (m) => m.descriptor.name === 'vantik.queue.job.duration',
    );
    expect(
      duration?.dataPoints.some(
        (p) =>
          p.attributes.queue === 'cycles' &&
          p.attributes.outcome === 'completed',
      ),
    ).toBe(true);

    const wait = all.find((m) => m.descriptor.name === 'vantik.queue.job.wait');
    const waitPoint = wait?.dataPoints.find(
      (p) => p.attributes.queue === 'cycles',
    );
    expect((waitPoint?.value as { sum: number }).sum).toBeGreaterThan(1);

    const depth = all.find((m) => m.descriptor.name === 'vantik.queue.jobs');
    const waiting = depth?.dataPoints.find(
      (p) =>
        p.attributes.queue === 'cycles' && p.attributes.state === 'waiting',
    );
    expect(waiting?.value).toBe(3);
    expect(
      depth?.dataPoints.some((p) => p.attributes.state === 'completed'),
    ).toBe(false);
  });

  it('carries the trace of the caller into the job, and back out of it', async () => {
    const tracer = trace.getTracer('test');
    await tracer.startActiveSpan('POST /issues', async (request) => {
      await Job.create({}, 'name', {}, { attempts: 1 });
      request.end();
    });

    const opts = create.mock.calls[0][3] as Record<string, unknown>;
    expect(opts.attempts).toBe(1);
    expect(opts.traceContext).toEqual({
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-/),
    });

    const run = register(fakeQueue('issues'), async () => 'ok');
    await run(job({ opts: opts as Queue.JobOptions }));

    const finished = spans.getFinishedSpans();
    const parent = finished.find((s) => s.name === 'POST /issues')!;
    const child = finished.find((s) => s.name === 'process issues')!;
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it('leaves a repeatable job and a call outside a span unchanged', async () => {
    create.mockClear();
    const repeat = { repeat: { every: 1000 } };

    await trace.getTracer('test').startActiveSpan('cron', async (span) => {
      await Job.create({}, 'name', {}, repeat);
      span.end();
    });
    await context.with(context.active(), () =>
      Job.create({}, 'name', {}, { attempts: 2 }),
    );

    expect(create.mock.calls[0][3]).toBe(repeat);
    expect(create.mock.calls[1][3]).toEqual({ attempts: 2 });
  });

  it('adds the trace context to each job of a bulk add', async () => {
    await trace.getTracer('test').startActiveSpan('bulk', async (span) => {
      await Job.createBulk({}, [{ opts: {} }, { opts: { lifo: true } }]);
      span.end();
    });

    const jobs = createBulk.mock.calls[0][1] as Array<{
      opts: Record<string, unknown>;
    }>;
    expect(jobs.every((j) => j.opts.traceContext)).toBe(true);
    expect(jobs[1].opts.lifo).toBe(true);
  });
});
