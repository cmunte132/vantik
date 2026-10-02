/**
 * Telemetry for the Bull queues: a span for each job, the duration and the
 * wait time of each job, and the number of jobs in each state.
 *
 * The spans and the duration follow the OpenTelemetry semantic conventions for
 * messaging, so a backend that knows those conventions shows the queues with
 * no setup: a `send <queue>` producer span when a job is added, a
 * `process <queue>` consumer span for each attempt, and the
 * `messaging.process.duration` histogram. The wait time and the depth have no
 * convention, so they are `vantik.queue.*` metrics with the same attributes.
 *
 * Bull has no OpenTelemetry instrumentation, so this module patches two
 * points in Bull itself:
 *
 * - `Queue.prototype.setHandler` stores the processor of a job name. The patch
 *   puts a wrapper around the processor. `@nestjs/bull` calls
 *   `queue.process()` for each `@Process()` method, and `process()` calls
 *   `setHandler()`, so every processor in the server gets the wrapper.
 * - `Job.create` and `Job.createBulk` write a job to Redis. The patch runs the
 *   write in a producer span and adds that span's trace context to the options
 *   of the job. The job span then becomes a child of the request or the job
 *   that added it.
 *
 * The patches must be in place before Nest starts the processors. The bull
 * module imports this file, so Node runs it when it loads the app module.
 *
 * If telemetry is off, the OpenTelemetry API is a no-op. The wrapper then
 * costs one function call for each job.
 */
import {
  context,
  Histogram,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  ValueType,
} from '@opentelemetry/api';
import Queue from 'bull';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Job = require('bull/lib/job');

/** The key in the options of a job that holds the trace context. */
const TRACE_CONTEXT = 'traceContext';

/** Bull gives this name to a job that the caller did not name. */
const DEFAULT_JOB_NAME = '__default__';

const tracer = trace.getTracer('vantik-bull');

// Job durations go from a few milliseconds to many minutes for an agent run.
const DURATION_BUCKETS = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600,
];

/** The queues that have a processor in this process. */
const queues = new Set<Queue.Queue>();

const STATES = ['waiting', 'active', 'delayed', 'failed', 'paused'] as const;

const MESSAGING_SYSTEM = 'bull';

let instruments:
  | {
      jobDuration: Histogram;
      jobWait: Histogram;
    }
  | undefined;

/**
 * This function makes the instruments when a processor first needs them. The
 * metrics API has no proxy: a meter that a module gets before the SDK starts
 * stays a no-op. If the instruments come later, the load order does not
 * matter.
 */
function getInstruments() {
  if (instruments) {
    return instruments;
  }
  const meter = metrics.getMeter('vantik-bull');

  const jobCounts = meter.createObservableGauge('vantik.queue.jobs', {
    description: 'The number of jobs in each state, for each queue.',
    valueType: ValueType.INT,
  });
  jobCounts.addCallback(async (result) => {
    await Promise.all(
      [...queues].map(async (queue) => {
        try {
          const counts = (await queue.getJobCounts()) as unknown as Record<
            string,
            number
          >;
          for (const state of STATES) {
            result.observe(counts[state] ?? 0, {
              'messaging.system': MESSAGING_SYSTEM,
              'messaging.destination.name': queue.name,
              'vantik.queue.state': state,
            });
          }
        } catch {
          // If Redis does not answer, this export has no count for the
          // queue. The gap in the graph shows the problem better than a zero.
        }
      }),
    );
  });

  instruments = {
    jobDuration: meter.createHistogram('messaging.process.duration', {
      description: 'The time that a processor used for one attempt of a job.',
      unit: 's',
      valueType: ValueType.DOUBLE,
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    jobWait: meter.createHistogram('vantik.queue.job.wait', {
      description:
        'The time from when a job was ready to when a processor started it.',
      unit: 's',
      valueType: ValueType.DOUBLE,
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
  };
  return instruments;
}

function jobLabel(name: string): string {
  return name === DEFAULT_JOB_NAME ? 'default' : name;
}

type Processor = (job: Queue.Job) => Promise<unknown>;

/**
 * This function runs one attempt of a job inside a span, and records its
 * duration and its wait time.
 */
function traced(queue: Queue.Queue, job: Queue.Job, run: Processor) {
  const name = jobLabel(job.name);
  const attributes = {
    'messaging.system': MESSAGING_SYSTEM,
    'messaging.operation.name': 'process',
    'messaging.destination.name': queue.name,
    'vantik.queue.job': name,
  };
  const started = Date.now();
  const { jobDuration, jobWait } = getInstruments();

  // The time when the job became ready. For a delayed job, that is the end of
  // the delay. For a retry, Bull keeps the first timestamp, so the wait of a
  // retry also includes the earlier attempts and the backoff.
  const ready = job.timestamp + (job.opts.delay ?? 0);
  jobWait.record(Math.max(0, started - ready) / 1000, attributes);

  const carrier = (job.opts as Record<string, unknown>)[TRACE_CONTEXT];
  const parent =
    carrier && typeof carrier === 'object'
      ? propagation.extract(context.active(), carrier)
      : context.active();

  // The convention names the span after the operation and the destination
  // only. The job name is an attribute, so one queue is one span name.
  return tracer.startActiveSpan(
    `process ${queue.name}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        ...attributes,
        'messaging.operation.type': 'process',
        'messaging.message.id': String(job.id),
        'vantik.queue.attempt': job.attemptsMade + 1,
      },
    },
    parent,
    async (span) => {
      try {
        const value = await run(job);
        jobDuration.record((Date.now() - started) / 1000, attributes);
        return value;
      } catch (error) {
        jobDuration.record((Date.now() - started) / 1000, {
          ...attributes,
          'error.type': errorType(error),
        });
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error)?.message,
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** The class of an error, which is what the convention puts in error.type. */
function errorType(error: unknown): string {
  return error instanceof Error ? error.constructor.name : '_OTHER';
}

/**
 * This function returns true if adding a job should make a producer span. It
 * does not trace a repeatable job: Bull adds the next repetition from inside
 * the current one, so a parent span would chain every repetition into one
 * trace without an end. A job added outside any span is not traced either,
 * because a lone producer span says nothing about who added the job.
 */
function shouldTrace(opts: Record<string, unknown> | undefined): boolean {
  return !!opts && !opts.repeat && !!trace.getSpan(context.active());
}

/** The options of a new job, with the trace context of the active span. */
function withTraceContext(opts: Record<string, unknown>) {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length
    ? { ...opts, [TRACE_CONTEXT]: carrier }
    : opts;
}

function queueName(queue: unknown): string {
  return (queue as { name?: string })?.name ?? 'unknown';
}

/**
 * This function runs the write of one or more jobs in a `send <queue>`
 * producer span. The write itself makes the Redis spans, which become the
 * children of this span.
 */
function sending<T>(
  queue: unknown,
  count: number,
  write: () => Promise<T>,
): Promise<T> {
  const name = queueName(queue);

  return tracer.startActiveSpan(
    `send ${name}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.system': MESSAGING_SYSTEM,
        'messaging.operation.type': 'send',
        'messaging.operation.name': 'send',
        'messaging.destination.name': name,
        ...(count > 1 ? { 'messaging.batch.message_count': count } : {}),
      },
    },
    async (span) => {
      try {
        return await write();
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error)?.message,
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

let patched = false;

export function patchBull(): void {
  if (patched) {
    return;
  }
  patched = true;

  const prototype = Queue.prototype as unknown as {
    setHandler(this: Queue.Queue, name: string, handler: unknown): void;
    handlers: Record<string, Processor>;
  };
  const setHandler = prototype.setHandler;
  prototype.setHandler = function (name, handler) {
    setHandler.call(this, name, handler);
    const handlers = (this as unknown as typeof prototype).handlers;
    const inner = handlers[name];
    handlers[name] = (job) => traced(this, job, inner);
    queues.add(this);
    getInstruments();
  };

  const create = Job.create;
  Job.create = function (
    queue: unknown,
    name: unknown,
    data: unknown,
    opts?: Record<string, unknown>,
  ) {
    if (!shouldTrace(opts)) {
      return create.call(this, queue, name, data, opts);
    }
    return sending(queue, 1, () =>
      create.call(this, queue, name, data, withTraceContext(opts!)),
    );
  };

  const createBulk = Job.createBulk;
  Job.createBulk = function (
    queue: unknown,
    jobs: Array<{ opts?: Record<string, unknown> }>,
  ) {
    if (!trace.getSpan(context.active())) {
      return createBulk.call(this, queue, jobs);
    }
    return sending(queue, jobs.length, () =>
      createBulk.call(
        this,
        queue,
        jobs.map((job) =>
          shouldTrace(job.opts)
            ? { ...job, opts: withTraceContext(job.opts!) }
            : job,
        ),
      ),
    );
  };
}

patchBull();
