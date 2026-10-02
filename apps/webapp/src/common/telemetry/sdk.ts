/**
 * The OTel web SDK, loaded only when the server relays browser telemetry. See
 * ./index for the switch and the reason it is a separate chunk.
 *
 * What it sends, all through the relay at /api/v1/telemetry:
 *
 * - Traces: the document load, and each fetch to the API. The fetch
 *   instrumentation puts `traceparent` on same-origin requests, so a click and
 *   the server work behind it are one trace.
 * - Logs: errors, with the `exception.*` semantic convention attributes, and
 *   Core Web Vitals as `browser.web_vital` events.
 */
import type { ErrorAttributes } from './index';

import { context, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {
  BatchSpanProcessor,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions';
import { type Metric, onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';

const RELAY = '/api/v1/telemetry';

/** The server stamps this too; it is set here so local debugging reads right. */
const SERVICE_NAME = 'vantik-webapp';

/**
 * One id per tab, so a backend can group what one visit did. It is random and
 * lives in sessionStorage, so it names no person and ends with the tab.
 */
function sessionId(): string {
  const key = 'vantik.telemetry.session';

  try {
    const existing = sessionStorage.getItem(key);
    if (existing) {
      return existing;
    }

    const created = crypto.randomUUID();
    sessionStorage.setItem(key, created);

    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export function startTelemetry(): (
  error: unknown,
  attributes?: ErrorAttributes,
) => void {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: import.meta.env.VANTIK_BUILD_ID,
    'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    'session.id': sessionId(),
  });

  const origin = window.location.origin;

  // Both batch processors flush by themselves when the page is hidden, which is
  // when the final Web Vitals are reported.
  const tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${origin}${RELAY}/traces` }),
      ),
    ],
  });
  tracerProvider.register();

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${origin}${RELAY}/logs` }),
      }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  registerInstrumentations({
    instrumentations: [
      new DocumentLoadInstrumentation(),
      new FetchInstrumentation({
        // The exporter's own requests. Tracing them would trace the tracing.
        ignoreUrls: [new RegExp(`${RELAY}/`)],
      }),
    ],
  });

  const logger = loggerProvider.getLogger(SERVICE_NAME);

  const reportVital = (metric: Metric) => {
    logger.emit({
      eventName: 'browser.web_vital',
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: `${metric.name} ${metric.value}`,
      attributes: {
        'web_vital.name': metric.name,
        'web_vital.value': metric.value,
        'web_vital.rating': metric.rating,
        'web_vital.id': metric.id,
        'web_vital.navigation_type': metric.navigationType,
        [ATTR_URL_PATH]: window.location.pathname,
      },
    });
  };
  onCLS(reportVital);
  onFCP(reportVital);
  onINP(reportVital);
  onLCP(reportVital);
  onTTFB(reportVital);

  return (error, attributes) => {
    const normalised =
      error instanceof Error ? error : new Error(String(error ?? 'Unknown'));

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: normalised.message,
      // Ties the error to the span that was active when it was thrown, so the
      // backend can show it inside its trace.
      context: trace.getActiveSpan() ? context.active() : undefined,
      attributes: {
        ...attributes,
        [ATTR_EXCEPTION_TYPE]: normalised.name,
        [ATTR_EXCEPTION_MESSAGE]: normalised.message,
        ...(normalised.stack
          ? { [ATTR_EXCEPTION_STACKTRACE]: normalised.stack }
          : {}),
        [ATTR_URL_PATH]: window.location.pathname,
      },
    });
  };
}
