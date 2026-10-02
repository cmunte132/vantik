/**
 * Browser telemetry, in OpenTelemetry and nothing else.
 *
 * Vantik takes no side on the observability backend. The page exports OTLP to
 * the Vantik server, and the server relays it to whatever endpoint the operator
 * configured for its own telemetry. When the server has no endpoint, the page
 * loads no SDK at all.
 *
 * This file stays free of OTel imports, so that an install with telemetry off
 * does not download the SDK. The SDK is in ./sdk and is loaded on demand.
 */
import { loadClientConfig } from 'common/lib/client-config';

export type ErrorAttributes = Record<string, string>;

type Reporter = (error: unknown, attributes?: ErrorAttributes) => void;

let reporter: Reporter | undefined;

/**
 * Errors that occur before the config request lands. They are sent once the
 * SDK starts, or discarded if telemetry is off. The cap keeps a page that
 * throws in a loop from holding on to every error.
 */
const MAX_PENDING = 20;
const pending: Array<[unknown, ErrorAttributes | undefined]> = [];

/**
 * Reports an error to the configured backend. Safe to call at any time: before
 * the SDK has loaded the error waits, and with telemetry off it is dropped.
 */
export function reportError(error: unknown, attributes?: ErrorAttributes) {
  if (reporter) {
    reporter(error, attributes);
  } else if (pending.length < MAX_PENDING) {
    pending.push([error, attributes]);
  }
}

/**
 * Starts browser telemetry if the server relays it.
 *
 * The global error listeners go on first, before the config request, so an
 * error in the first moments of boot is held and sent rather than lost.
 */
export async function initTelemetry(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, {
      'vantik.error.source': 'window',
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { 'vantik.error.source': 'unhandledrejection' });
  });

  const { telemetryEnabled } = await loadClientConfig();

  if (!telemetryEnabled) {
    reporter = () => undefined;
    pending.length = 0;

    return;
  }

  try {
    const { startTelemetry } = await import('./sdk');
    reporter = startTelemetry();
  } catch (error) {
    // Telemetry must never take the page down. A chunk that fails to load is
    // the likely cause, and there is nowhere to report it to.
    // eslint-disable-next-line no-console
    console.warn('Browser telemetry did not start', error);
    reporter = () => undefined;
  }

  for (const [error, attributes] of pending.splice(0)) {
    reporter(error, attributes);
  }
}
