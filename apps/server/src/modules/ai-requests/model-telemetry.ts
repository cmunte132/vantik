/**
 * Spans and metrics for the model calls in model-call.ts.
 *
 * The names follow the OpenTelemetry semantic conventions for generative AI.
 * In Prometheus they become:
 *
 * - `gen_ai_client_operation_duration_seconds`: a histogram of the call
 *   durations.
 * - `gen_ai_client_token_usage`: a histogram of the tokens for each call, with
 *   `gen_ai_token_type` set to `input` or `output`.
 *
 * Each metric also has `vantik_llm_purpose` and `vantik_llm_role`, so a
 * dashboard can show which feature uses the model time and the tokens.
 *
 * The span does not hold the prompt or the answer. Those can be large and can
 * hold private data. When LOG_LEVEL is `debug`, model-call.ts writes them to
 * the log, and the log line has the trace id of the span.
 *
 * If telemetry is off, the OpenTelemetry API is a no-op and this file does
 * nothing.
 */
import type { LanguageModelUsage } from 'ai';

import {
  context,
  Histogram,
  metrics,
  Span,
  SpanKind,
  SpanStatusCode,
  trace,
  ValueType,
} from '@opentelemetry/api';

const tracer = trace.getTracer('vantik-llm');

let instruments: { duration: Histogram; tokens: Histogram } | undefined;

/**
 * This function makes the instruments on the first call. The metrics API has
 * no proxy: a meter that a module gets before the SDK starts stays a no-op.
 * The bucket boundaries are the ones that the semantic conventions recommend.
 * Exported so agent runs record their sandbox model calls on the same
 * histograms.
 */
export function genAiInstruments() {
  if (instruments) {
    return instruments;
  }
  const meter = metrics.getMeter('vantik-llm');
  instruments = {
    duration: meter.createHistogram('gen_ai.client.operation.duration', {
      description: 'The duration of a model call.',
      unit: 's',
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [
          0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24,
          20.48, 40.96, 81.92, 163.84, 327.68,
        ],
      },
    }),
    tokens: meter.createHistogram('gen_ai.client.token.usage', {
      description: 'The number of tokens in one model call.',
      unit: '{token}',
      valueType: ValueType.INT,
      advice: {
        explicitBucketBoundaries: [
          1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
        ],
      },
    }),
  };
  return instruments;
}

export interface ModelTelemetry {
  /** This method records the role and the model after the call resolves them. */
  setModel(role: string | null, model: string | null): void;
  /** This method runs `fn` with the span as the active span. */
  run<T>(fn: () => T): T;
  finish(
    usage: LanguageModelUsage | undefined,
    finishReason: string | undefined,
    steps?: number,
  ): void;
  fail(error: unknown): void;
}

/**
 * This function starts the span of one model call. The caller must call
 * `finish` or `fail` once. A second call does nothing.
 */
export function startModelTelemetry(
  purpose: string,
  role: string | null = null,
  model: string | null = null,
  provider?: string,
): ModelTelemetry {
  const started = Date.now();
  const span: Span = tracer.startSpan(`chat ${model ?? purpose}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'vantik.llm.purpose': purpose,
      ...(provider ? { 'gen_ai.provider.name': provider } : {}),
    },
  });
  let ended = false;

  const setModel = (nextRole: string | null, nextModel: string | null) => {
    role = nextRole;
    model = nextModel;
    if (role) {
      span.setAttribute('vantik.llm.role', role);
    }
    if (model) {
      span.setAttribute('gen_ai.request.model', model);
      span.updateName(`chat ${model}`);
    }
  };
  setModel(role, model);

  const metricAttributes = () => ({
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': model ?? 'unknown',
    'vantik.llm.purpose': purpose,
    'vantik.llm.role': role ?? 'none',
  });

  return {
    setModel,

    run(fn) {
      return context.with(trace.setSpan(context.active(), span), fn);
    },

    finish(usage, finishReason, steps) {
      if (ended) {
        return;
      }
      ended = true;

      const { duration, tokens } = genAiInstruments();
      const attributes = metricAttributes();
      duration.record((Date.now() - started) / 1000, attributes);
      if (usage?.inputTokens !== undefined) {
        tokens.record(usage.inputTokens, {
          ...attributes,
          'gen_ai.token.type': 'input',
        });
        span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens);
      }
      if (usage?.outputTokens !== undefined) {
        tokens.record(usage.outputTokens, {
          ...attributes,
          'gen_ai.token.type': 'output',
        });
        span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens);
      }
      const cached = usage?.inputTokenDetails?.cacheReadTokens;
      if (cached !== undefined) {
        span.setAttribute('gen_ai.usage.cache_read.input_tokens', cached);
      }
      if (finishReason) {
        span.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
      }
      if (steps !== undefined) {
        span.setAttribute('vantik.llm.steps', steps);
      }
      span.end();
    },

    fail(error) {
      if (ended) {
        return;
      }
      ended = true;

      const errorType =
        error instanceof Error ? error.name || 'Error' : '_OTHER';
      genAiInstruments().duration.record((Date.now() - started) / 1000, {
        ...metricAttributes(),
        'error.type': errorType,
      });
      span.setAttribute('error.type', errorType);
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.end();
    },
  };
}
