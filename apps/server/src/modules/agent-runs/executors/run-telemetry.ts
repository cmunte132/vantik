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

import {
  guardrailOf,
  ModelCallTimings,
  languageServerOf,
  modelCallOf,
  statusOfError,
} from './pi-events';
import { genAiInstruments } from '../../ai-requests/model-telemetry';

const tracer = trace.getTracer('vantik-agent');

let instruments:
  | {
      finished: Counter;
      duration: Histogram;
      cost: Histogram;
      turns: Histogram;
      guardrails: Counter;
      timeToFirstToken: Histogram;
      languageServers: Histogram;
      retries: Counter;
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
    guardrails: meter.createCounter('vantik.agent_run.guardrail', {
      description:
        'Times the Vantik extension stopped a tool call or asked an agent to continue. A spike is a prompt-injection signal.',
      unit: '{hit}',
      valueType: ValueType.INT,
    }),
    timeToFirstToken: meter.createHistogram('vantik.llm.time_to_first_token', {
      description:
        'From an agent run sending a model request to the first streamed update, as the Vantik extension measured it in the sandbox.',
      unit: 's',
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120],
      },
    }),
    languageServers: meter.createHistogram(
      'vantik.agent_run.language_server.start',
      {
        description:
          'Time for a language server in an agent run to start, or to be given up on, by server and outcome.',
        unit: 's',
        valueType: ValueType.DOUBLE,
        advice: {
          explicitBucketBoundaries: [0.25, 0.5, 1, 2, 4, 8, 15, 30, 60],
        },
      },
    ),
    retries: meter.createCounter('vantik.agent_run.model_retries', {
      description:
        'Model calls an agent run retried after the provider failed them.',
      unit: '{retry}',
      valueType: ValueType.INT,
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
  let guardrailHits = 0;
  // What the extension said about the call now in flight, and how many calls
  // it did and did not report: a run whose records stop partway has had its
  // extension disabled, which is worth knowing whatever the reason.
  let timings: ModelCallTimings | null = null;
  let modelCalls = 0;
  let reportedCalls = 0;
  let invalidRecords = 0;
  let retries = 0;
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

      // Recorded before the tool span ends below, so the hit lands on it too.
      const hit = guardrailOf(event);
      if (hit) {
        guardrailHits += 1;
        const attributes = {
          'vantik.guardrail.rule': hit.rule,
          'vantik.guardrail.action': hit.action,
          ...(hit.tool ? { 'gen_ai.tool.name': hit.tool } : {}),
        };
        (phaseSpan ?? root).addEvent('vantik.guardrail', attributes);
        if (hit.toolCallId) {
          tools
            .get(hit.toolCallId)
            ?.setAttribute('vantik.guardrail.rule', hit.rule);
        }
        getInstruments().guardrails.add(1, {
          'vantik.guardrail.rule': hit.rule,
          'vantik.guardrail.action': hit.action,
        });
      }
      const server = languageServerOf(event);
      if (server === null) {
        invalidRecords += 1;
        return;
      }
      if (server) {
        const attributes = {
          'vantik.language_server': server.server,
          'vantik.language_server.outcome': server.outcome,
        };
        (phaseSpan ?? root).addEvent('vantik.language_server', {
          ...attributes,
          'vantik.language_server.ms': server.ms,
        });
        getInstruments().languageServers.record(server.ms / 1000, attributes);
        return;
      }

      const record = modelCallOf(event);
      if (record === null) {
        invalidRecords += 1;
        return;
      }
      if (record) {
        timings = record;
        return;
      }

      if (type === 'auto_retry_start') {
        retries += 1;
        const status = statusOfError(event.errorMessage);
        const attributes = {
          'vantik.retry.attempt': Number(event.attempt) || 0,
          ...(status ? { 'http.response.status_code': status } : {}),
        };
        (phaseSpan ?? root).addEvent('vantik.model_retry', {
          ...attributes,
          ...(typeof event.delayMs === 'number'
            ? { 'vantik.retry.delay_ms': event.delayMs }
            : {}),
        });
        getInstruments().retries.add(1, {
          'gen_ai.provider.name': provider ?? 'unknown',
          'gen_ai.request.model': model ?? 'unknown',
          'error.type': status ? String(status) : 'model_error',
        });
        return;
      }

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
        const reported = timings;
        timings = null;
        modelCalls += 1;

        const failed = message.stopReason === 'error';
        const status =
          reported?.status ??
          (failed ? statusOfError(message.errorMessage) : null);

        // The extension's clock starts when the request left; the span's only
        // when the answer began to stream, so prefer the extension's.
        duration.record(
          (reported ? reported.durationMs : Date.now() - started) / 1000,
          {
            ...attributes,
            ...(failed
              ? { 'error.type': status ? String(status) : 'model_error' }
              : {}),
          },
        );

        if (status) {
          span.setAttribute('http.response.status_code', status);
        }
        if (reported) {
          reportedCalls += 1;
          span.setAttribute('vantik.llm.duration', reported.durationMs / 1000);
          if (reported.responseMs !== undefined) {
            span.setAttribute(
              'vantik.llm.response_time',
              reported.responseMs / 1000,
            );
          }
          if (reported.ttftMs !== undefined) {
            span.setAttribute(
              'vantik.llm.time_to_first_token',
              reported.ttftMs / 1000,
            );
            getInstruments().timeToFirstToken.record(
              reported.ttftMs / 1000,
              attributes,
            );
          }
        }

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
      root.setAttribute('vantik.agent_run.guardrail_hits', guardrailHits);
      root.setAttribute('vantik.agent_run.model_calls', modelCalls);
      root.setAttribute('vantik.agent_run.model_retries', retries);
      root.setAttribute(
        'vantik.agent_run.model_calls_unreported',
        modelCalls - reportedCalls,
      );
      // Reported some calls, then stopped: the extension was disabled partway.
      if (reportedCalls > 0 && reportedCalls < modelCalls) {
        root.setAttribute('vantik.agent_run.extension_went_silent', true);
      }
      if (invalidRecords > 0) {
        root.setAttribute(
          'vantik.agent_run.extension_records_invalid',
          invalidRecords,
        );
      }
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
