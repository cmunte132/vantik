/**
 * Where the browser's telemetry goes: the same OTLP endpoint, with the same
 * headers, that the server exports its own telemetry to.
 *
 * The browser never learns the endpoint or its credentials. It posts to the
 * Vantik server, and the server forwards. That keeps Vantik neutral about the
 * backend: an operator who points OTEL_EXPORTER_OTLP_ENDPOINT at Grafana,
 * OpenObserve, Honeycomb or a collector gets the browser's data there too, with
 * no vendor SDK in the page, no CORS setup and no second set of variables.
 */

/** The OTLP signals the browser sends. Metrics stay server-side. */
export const RELAYED_SIGNALS = ['traces', 'logs'] as const;

export type RelayedSignal = (typeof RELAYED_SIGNALS)[number];

export function isRelayedSignal(value: string): value is RelayedSignal {
  return (RELAYED_SIGNALS as readonly string[]).includes(value);
}

/**
 * The service name every relayed resource carries.
 *
 * The relay is unauthenticated, because a page reports errors before anybody
 * has signed in. Without this, a caller could post spans that claim to come
 * from the server and pollute its traces and error rates.
 */
export const BROWSER_SERVICE_NAME = 'vantik-webapp';

export interface RelayTarget {
  url: string;
  headers: Record<string, string>;
}

type Env = Record<string, string | undefined>;

/**
 * Resolves the target the way the OTel exporters do, so that the relay and
 * the server's own export never disagree:
 *
 * - `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT` is a full URL and is used as is.
 * - Otherwise `OTEL_EXPORTER_OTLP_ENDPOINT` is a base, and `/v1/<signal>` is
 *   appended.
 * - Signal headers are merged over the general ones.
 *
 * Returns undefined when no endpoint is configured, which is the default:
 * telemetry is off and the browser's data is discarded.
 */
export function relayTarget(
  signal: RelayedSignal,
  env: Env = process.env,
): RelayTarget | undefined {
  const upper = signal.toUpperCase();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const specific = env[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`]?.trim();

  const url =
    specific || (base ? `${base.replace(/\/+$/, '')}/v1/${signal}` : '');
  if (!url) {
    return undefined;
  }

  return {
    url,
    headers: {
      ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseOtlpHeaders(env[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`]),
    },
  };
}

/**
 * Parses the OTel header list format: `key=value` pairs separated by commas,
 * with each part percent-encoded. A pair without `=` is skipped, as the SDK
 * skips it.
 */
export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) {
      continue;
    }

    const key = safeDecode(pair.slice(0, at).trim());
    const value = safeDecode(pair.slice(at + 1).trim());
    if (key) {
      headers[key] = value;
    }
  }

  return headers;
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

interface OtlpAttribute {
  key?: unknown;
  value?: unknown;
}

interface OtlpResourceContainer {
  resource?: { attributes?: OtlpAttribute[] };
}

/** The top-level array an OTLP/JSON export request holds, per signal. */
const RESOURCE_KEY: Record<RelayedSignal, string> = {
  traces: 'resourceSpans',
  logs: 'resourceLogs',
};

/**
 * Checks that the body is an OTLP/JSON export request for the signal, and
 * stamps BROWSER_SERVICE_NAME on every resource in it.
 *
 * Returns undefined for anything that is not that shape, so the caller can
 * refuse it rather than forward arbitrary JSON to the operator's backend.
 */
export function sanitiseExport(
  signal: RelayedSignal,
  body: unknown,
): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  const key = RESOURCE_KEY[signal];
  const containers = (body as Record<string, unknown>)[key];
  if (!Array.isArray(containers)) {
    return undefined;
  }

  const stamped = containers.map((container: OtlpResourceContainer) => {
    const attributes = (container?.resource?.attributes ?? []).filter(
      (attribute) => attribute?.key !== 'service.name',
    );

    return {
      ...container,
      resource: {
        ...container?.resource,
        attributes: [
          ...attributes,
          { key: 'service.name', value: { stringValue: BROWSER_SERVICE_NAME } },
        ],
      },
    };
  });

  return { [key]: stamped };
}
