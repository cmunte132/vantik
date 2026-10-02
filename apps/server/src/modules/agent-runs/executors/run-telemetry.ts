/**
 * Spans and metrics for agent runs.
 *
 * A run is one trace. The root span is `invoke_agent <agent>`; under it is one
 * span per phase (setup, implement, verify, review, revise-N, handback), and
 * under a phase are the model calls (`chat <model>`) and tool calls
 * (`execute_tool <name>`) the harness reported. Names and attributes follow the
 * OpenTelemetry semantic conventions for generative AI, so any OTLP backend
 * reads them the same way.
 *
 * The model calls happen inside the sandbox, not in this process, so their
 * spans are built from the harness's event stream: started when Pi says a
 * message started and ended when it says the message settled. Their tokens go
 * to the same `gen_ai.client.token.usage` histogram the server's own model
 * calls use, with `vantik.llm.purpose` set to `agent_run` so a dashboard can
 * tell the two apart.
 *
 * The run-level metrics — finished, duration, cost, turns — are recorded by
 * `recordRunFinished`, which `AgentRunsService.transition` calls on every
 * terminal state, so a run that ends without its executor (swept, cancelled)
 * is still counted.
 *
 * Nothing here holds a prompt, a message, a command or a tool's output. Those
 * are on the run's timeline, scrubbed, where access to them is checked.
 */
import {
  context,
  Context,
  Counter,
  Histogram,
  metrics,
  Span,
  SpanKind,
  SpanStatusCode,
  trace,
  ValueType,
} from '@opentelemetry/api';

import { genAiInstruments } from '../../ai-requests/model-telemetry';

const tracer = trace.getTracer('vantik-agent');

let instruments:
  | {
      finished: Counter;
      duration: Histogram;
      cost: Histogram;
      turns: Histogram;
    }
  | undefined;

/** Made on first use, for the same reason as in model-telemetry.ts. */
function getInstruments() {
  if (instruments) {
    return instruments;
  }
  const meter = metrics.getMeter('vantik-agent');
  instruments = {
    finished: meter.createCounter('vantik.agent_run.finished', {
      description: 'Agent runs that reached a terminal state.',
      unit: '{run}',
      valueType: ValueType.INT,
    }),
    duration: meter.createHistogram('vantik.agent_run.duration', {
      description:
        'Wall-clock time from claim (or creation) to the end of an agent run.',
      unit: 's',
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [
          5, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200,
        ],
      },
    }),
    cost: meter.createHistogram('vantik.agent_run.cost', {
      description:
        'What the model calls of one agent run cost, as reported by the provider.',
      unit: '{USD}',
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [
          0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25,
        ],
      },
    }),
    turns: meter.createHistogram('vantik.agent_run.turns', {
      description: 'Assistant turns in one agent run.',
      unit: '{turn}',
      valueType: ValueType.INT,
      advice: {
        explicitBucketBoundaries: [1, 2, 5, 10, 20, 40, 80, 160, 320, 640],
      },
    }),
  };
  return instruments;
}

/** The fields of a finished run the metrics read. A Prisma row satisfies it. */
export interface FinishedRun {
  executor: string;
  status: string;
  failure?: string | null;
  modelId?: string | null;
  iterationCount?: number | null;
  createdAt: Date;
  claimedAt?: Date | null;
  finishedAt?: Date | null;
  result?: unknown;
}

/** Counts one run's end. Never throws: a metric is not a reason to fail a run. */
export function recordRunFinished(run: FinishedRun): void {
  try {
    const { finished, duration, cost, turns } = getInstruments();
    const attributes = {
      'vantik.agent_run.executor': run.executor,
      'vantik.agent_run.status': run.status,
      'vantik.agent_run.failure': run.failure ?? 'none',
    };

    finished.add(1, attributes);

    const end = (run.finishedAt ?? new Date()).getTime();
    const start = (run.claimedAt ?? run.createdAt).getTime();
    if (end >= start) {
      duration.record((end - start) / 1000, attributes);
    }

    const result = (run.result ?? {}) as { costUsd?: unknown; turns?: unknown };
    if (typeof result.costUsd === 'number') {
      cost.record(result.costUsd, attributes);
    }
    const turnCount =
      typeof result.turns === 'number' ? result.turns : run.iterationCount;
    if (turnCount) {
      turns.record(turnCount, attributes);
    }
  } catch {
    // Telemetry is bookkeeping.
  }
}

export interface RunTelemetryInput {
  runId: string;
  issueId: string;
  agentUserId: string;
  executor: string;
  attempt?: number;
  provider?: string | null;
  model?: string | null;
}

/** One harness event, as Pi writes it. */
type PiEvent = Record<string, unknown>;

/**
 * The trace of one run. Every method is safe to call after `end`, and none of
 * them throw.
 */
export interface RunTelemetry {
  /** Moves the run into a phase. A phase it is already in is a no-op. */
  phase(name: string): void;
  /** Feeds one harness event; builds model-call and tool-call spans. */
  observe(event: PiEvent): void;
  /** Ends the open phase span. Model and tool calls still open are ended too. */
  endPhase(): void;
  /** Ends the trace with the run's outcome. */
  end(outcome: {
    status: string;
    failure?: string | null;
    error?: string | null;
  }): void;
  /** The provider and model, once the run has resolved them. */
  setModel(provider: string | null, model: string | null): void;
}

export function startRunTelemetry(input: RunTelemetryInput): RunTelemetry {
  let provider = input.provider ?? null;
  let model = input.model ?? null;

  const root: Span = tracer.startSpan(`invoke_agent ${input.executor}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': input.agentUserId,
      'gen_ai.agent.name': input.executor,
      'vantik.agent_run.id': input.runId,
      'vantik.agent_run.executor': input.executor,
      'vantik.issue.id': input.issueId,
      ...(input.attempt !== undefined
        ? { 'vantik.agent_run.attempt': input.attempt }
        : {}),
    },
  });
  const rootContext: Context = trace.setSpan(context.active(), root);

  let phaseName: string | null = null;
  let phaseSpan: Span | null = null;
  let phaseContext: Context = rootContext;
  let chat: { span: Span; started: number } | null = null;
  const tools = new Map<string, Span>();
  let ended = false;

  const setModel = (nextProvider: string | null, nextModel: string | null) => {
    provider = nextProvider ?? provider;
    model = nextModel ?? model;
    if (provider) {
      root.setAttribute('gen_ai.provider.name', provider);
    }
    if (model) {
      root.setAttribute('gen_ai.request.model', model);
    }
  };
  setModel(provider, model);

  const closeChildren = () => {
    if (chat) {
      chat.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'The phase ended before the model call settled.',
      });
      chat.span.end();
      chat = null;
    }
    for (const span of tools.values()) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'The phase ended before the tool call finished.',
      });
      span.end();
    }
    tools.clear();
  };

  const endPhase = () => {
    closeChildren();
    phaseSpan?.end();
    phaseSpan = null;
    phaseName = null;
    phaseContext = rootContext;
  };

  const metricAttributes = (responseModel: string | null) => ({
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': provider ?? 'unknown',
    'gen_ai.request.model': model ?? responseModel ?? 'unknown',
    'vantik.llm.purpose': 'agent_run',
    'vantik.llm.role': phaseName ?? 'none',
  });

  const safely =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      if (ended) {
        return;
      }
      try {
        fn(...args);
      } catch {
        // Telemetry is bookkeeping.
      }
    };

  return {
    setModel: safely(setModel),

    phase: safely((name: string) => {
      if (name === phaseName) {
        return;
      }
      endPhase();
      phaseName = name;
      phaseSpan = tracer.startSpan(
        `agent_phase ${name}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            'vantik.agent_run.id': input.runId,
            'vantik.agent_run.phase': name,
          },
        },
        rootContext,
      );
      phaseContext = trace.setSpan(rootContext, phaseSpan);
    }),

    endPhase: safely(endPhase),

    observe: safely((event: PiEvent) => {
      const type = event.type;
      const message = event.message as
        | {
            role?: unknown;
            model?: unknown;
            usage?: unknown;
            stopReason?: unknown;
            errorMessage?: unknown;
          }
        | undefined;

      if (type === 'message_start' && message?.role === 'assistant') {
        chat?.span.end();
        chat = {
          started: Date.now(),
          span: tracer.startSpan(
            `chat ${model ?? 'unknown'}`,
            {
              kind: SpanKind.CLIENT,
              attributes: {
                'gen_ai.operation.name': 'chat',
                'vantik.llm.purpose': 'agent_run',
                ...(provider ? { 'gen_ai.provider.name': provider } : {}),
                ...(model ? { 'gen_ai.request.model': model } : {}),
              },
            },
            phaseContext,
          ),
        };
        return;
      }

      if (type === 'message_end' && message?.role === 'assistant') {
        const responseModel =
          typeof message.model === 'string' ? message.model : null;
        const usage = (message.usage ?? {}) as {
          input?: unknown;
          output?: unknown;
          cacheRead?: unknown;
          cacheWrite?: unknown;
          cost?: { total?: unknown };
        };
        const attributes = metricAttributes(responseModel);
        const { duration, tokens } = genAiInstruments();
        const span =
          chat?.span ??
          tracer.startSpan(
            `chat ${model ?? responseModel ?? 'unknown'}`,
            { kind: SpanKind.CLIENT },
            phaseContext,
          );
        const started = chat?.started ?? Date.now();
        chat = null;

        const failed = message.stopReason === 'error';
        duration.record((Date.now() - started) / 1000, {
          ...attributes,
          ...(failed ? { 'error.type': 'model_error' } : {}),
        });

        if (responseModel) {
          span.setAttribute('gen_ai.response.model', responseModel);
        }
        if (typeof message.stopReason === 'string') {
          span.setAttribute('gen_ai.response.finish_reasons', [
            message.stopReason,
          ]);
        }
        if (typeof usage.input === 'number') {
          tokens.record(usage.input, {
            ...attributes,
            'gen_ai.token.type': 'input',
          });
          span.setAttribute('gen_ai.usage.input_tokens', usage.input);
        }
        if (typeof usage.output === 'number') {
          tokens.record(usage.output, {
            ...attributes,
            'gen_ai.token.type': 'output',
          });
          span.setAttribute('gen_ai.usage.output_tokens', usage.output);
        }
        if (typeof usage.cacheRead === 'number') {
          span.setAttribute(
            'gen_ai.usage.cache_read.input_tokens',
            usage.cacheRead,
          );
        }
        if (typeof usage.cacheWrite === 'number') {
          span.setAttribute(
            'gen_ai.usage.cache_creation.input_tokens',
            usage.cacheWrite,
          );
        }
        if (typeof usage.cost?.total === 'number') {
          span.setAttribute('vantik.llm.cost_usd', usage.cost.total);
        }
        if (failed) {
          span.setAttribute('error.type', 'model_error');
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message:
              typeof message.errorMessage === 'string'
                ? message.errorMessage.slice(0, 500)
                : 'The model call failed.',
          });
        }
        span.end();
        return;
      }

      if (type === 'tool_execution_start') {
        const name = String(event.toolName ?? 'unknown');
        const id = String(event.toolCallId ?? `${name}-${tools.size}`);
        tools.set(
          id,
          tracer.startSpan(
            `execute_tool ${name}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                'gen_ai.operation.name': 'execute_tool',
                'gen_ai.tool.name': name,
                'gen_ai.tool.call.id': id,
              },
            },
            phaseContext,
          ),
        );
        return;
      }

      if (type === 'tool_execution_end') {
        const id = String(event.toolCallId ?? '');
        const span = tools.get(id);
        if (!span) {
          return;
        }
        tools.delete(id);
        if (event.isError) {
          span.setAttribute('error.type', 'tool_error');
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.end();
      }
    }),

    end: safely((outcome) => {
      endPhase();
      ended = true;
      root.setAttribute('vantik.agent_run.status', outcome.status);
      if (outcome.failure) {
        root.setAttribute('vantik.agent_run.failure', outcome.failure);
        root.setAttribute('error.type', outcome.failure);
      }
      if (outcome.status === 'FAILED') {
        root.setStatus({
          code: SpanStatusCode.ERROR,
          message: (outcome.error ?? outcome.failure ?? 'failed').slice(0, 500),
        });
      }
      root.end();
    }),
  };
}
