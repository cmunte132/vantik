export interface LogInput {
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
  where?: string;
  error?: Error;
}

/**
 * The shape of a serialised log line. Field names are deliberately short —
 * these are emitted on every request — but they are a public contract for
 * anything parsing our logs, so renaming one is a breaking change.
 */
export interface LoggerPrintFormat {
  timestamp: string;
  lvl: string;
  ctx: string; // logger context, e.g. the service name
  msg: string;
  wId?: string; // workspace id
  reqId?: string; // request id, mirrored from the x-request-id header
  opName?: string; // endpoint the request entered through
  aId?: string; // acting user id
  traceId?: string; // OpenTelemetry trace id, when a trace is active
  spanId?: string; // OpenTelemetry span id, when a trace is active
  where?: string; // call site, when the caller names one
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
  error?: SerialisedError;
}

/**
 * `JSON.stringify(new Error('boom'))` is `{}` — name, message and stack are
 * all non-enumerable. Errors have to be flattened by hand or they reach the
 * log as an empty object.
 */
export interface SerialisedError {
  name: string;
  message: string;
  stack?: string;
}
