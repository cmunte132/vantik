/**
 * OpenTelemetry bootstrap.
 *
 * This module must be evaluated before anything else in the process. Auto
 * instrumentation works by patching modules as they are `require`d, so any
 * module already resolved when `sdk.start()` runs is never patched. Import it
 * as the first statement of `main.ts` — `import './otel';` — and leave it
 * there. `import/order` ignores side-effect imports, so the linter will not
 * reorder it, but a hand edit that moves it below `./app.module` silently
 * costs us every database and Redis span. There is no error when that happens:
 * the SDK starts, the exporter connects, and the traces are simply thin.
 *
 * Telemetry is opt-in. With `OTEL_EXPORTER_OTLP_ENDPOINT` unset — the default
 * for self-hosted installs — nothing is registered and no data leaves the
 * process.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import {
  defaultResource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';

const SERVICE_NAME = 'vantik-server';

/**
 * Metrics are cumulative, so a longer interval costs resolution rather than
 * data — a delayed export still carries the running totals. Sixty seconds is
 * the OTel default and what most backends expect. `OTEL_METRIC_EXPORT_INTERVAL`
 * is the standard knob for tuning it, and is honoured here because passing
 * `exportIntervalMillis` explicitly would otherwise override it silently.
 */
function metricExportIntervalMs(): number {
  const configured = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

let sdk: NodeSDK | undefined;

export function startOtel(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

  // No endpoint, no telemetry. Returning before the SDK is constructed keeps
  // the instrumentation patches off the hot path entirely, rather than
  // installing them and dropping the spans at export time.
  if (!endpoint) {
    return;
  }

  // The SDK swallows its own errors by default, which turns a bad endpoint or
  // a TLS failure into silence. Route its diagnostics at the level the
  // operator asked for so a misconfigured exporter is visible.
  if (process.env.OTEL_LOG_LEVEL) {
    const level =
      DiagLogLevel[
        process.env.OTEL_LOG_LEVEL.toUpperCase() as keyof typeof DiagLogLevel
      ];
    if (level !== undefined) {
      diag.setLogger(new DiagConsoleLogger(), level);
    }
  }

  sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: process.env.VERSION ?? 'unknown',
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
          process.env.NODE_ENV ?? 'development',
      }),
    ),
    // The exporters read OTEL_EXPORTER_OTLP_HEADERS themselves, which is how
    // hosted collectors take their auth token.
    traceExporter: new OTLPTraceExporter(),
    // Metrics ride the same endpoint and the same on/off switch as traces:
    // with no collector configured there is nothing to look at, so running a
    // meter provider would be machinery nobody sees.
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: metricExportIntervalMs(),
      }),
    ],
    // Logs ride the same endpoint and switch as traces and metrics. The winston
    // instrumentation in the auto set below is what feeds this: it was already
    // active and already forwarding records, but with no processor registered
    // they went nowhere. Registering one is the whole of it — no log shipper, no
    // container socket to mount, and it works the same whether the server runs
    // in a container or on the host.
    //
    // stdout is untouched. The Console transport still writes the same JSON, so
    // `docker compose logs server` keeps working and an operator who collects
    // container logs the normal way loses nothing.
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // One span per file read drowns everything worth looking at.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Every socket and hostname resolution, almost all of it as orphan
        // traces with no request to hang off. Pure volume.
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Express 5 dispatches through the standalone `router` package, which
        // has its own instrumentation emitting a second `middleware - patched`
        // span for every layer — the same layers express already reports.
        // Disabling express's middleware spans alone leaves these behind.
        '@opentelemetry/instrumentation-router': { enabled: false },
        // Nest's own instrumentation names spans after the controller and
        // handler, which is the layer we actually reason about.
        '@opentelemetry/instrumentation-nestjs-core': { enabled: true },
        '@opentelemetry/instrumentation-express': {
          // Express emits a span per middleware layer. Measured on this app
          // that was 14 of the 22 spans on a health check — body parsers and
          // CORS, none of it actionable. Dropping the layer also moves the
          // request-id attribute set by ALSMiddleware up onto the route span,
          // where it can actually be searched for, instead of burying it on a
          // nested anonymous middleware span.
          ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
        },
      }),
      // Prisma runs its queries through its own engine rather than through the
      // `pg` driver, so the generic postgres instrumentation cannot see them:
      // without this the database layer is missing from every trace. Verified
      // against the running stack — `pg` spans alone produced zero children
      // under a request.
      new PrismaInstrumentation(),
      // Event loop lag, heap and GC. The symptom of most trouble in a Node
      // process is a stalled event loop, and no amount of request-level
      // instrumentation shows it — the slow request and the one blocking it
      // are usually not the same request.
      new RuntimeNodeInstrumentation(),
    ],
  });

  sdk.start();

  // Flush on the way out. Without this the last spans of a request that
  // triggered a shutdown — often the interesting ones — are lost.
  const shutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch (error) {
      // A failed flush must not stop the process from exiting.
      // eslint-disable-next-line no-console
      console.error('OpenTelemetry shutdown failed', error);
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startOtel();
