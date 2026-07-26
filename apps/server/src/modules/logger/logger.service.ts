import { Injectable } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import winston, { Logger as WinstonLogger, createLogger } from 'winston';

import config from 'common/configs/config';

import { ALS_SERVICE_INSTANCE } from 'modules/als/als.service';

import {
  LogInput,
  LoggerPrintFormat,
  SerialisedError,
} from './logger.interface';

function serialiseError(error: unknown): SerialisedError | undefined {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  if (typeof error === 'string') {
    return { name: 'UnknownError', message: error };
  }

  if (error && typeof error === 'object' && Object.keys(error).length) {
    return { name: 'UnknownError', message: JSON.stringify(error) };
  }

  return undefined;
}

/**
 * Puts the correlation ids onto the log record itself, before any transport
 * sees it.
 *
 * These used to be read straight out of AsyncLocalStorage inside `printLine`,
 * which worked only because the console was the one and only transport. The
 * winston instrumentation in the OTel auto set appends a second transport when
 * an OTLP endpoint is configured, and it builds its attributes from the record's
 * own fields — so anything conjured up inside the printf formatter is invisible
 * to it. Logs reached Grafana with no workspace, request or operation to filter
 * on, which is most of what makes a log line worth having.
 *
 * Enriching here instead means both sinks see the same fields. `printLine` keeps
 * emitting byte-identical stdout, because it reads the same values from the
 * record rather than fetching them itself.
 */
const withCorrelationIds = winston.format((info) => {
  const workspaceId = ALS_SERVICE_INSTANCE.get<string>('workspaceId');
  if (workspaceId) {
    info.wId = workspaceId;
  }

  const requestId = ALS_SERVICE_INSTANCE.get<string>('requestId');
  if (requestId) {
    info.reqId = requestId;
  }

  const opName = ALS_SERVICE_INSTANCE.get<string>('opName');
  if (opName) {
    info.opName = opName;
  }

  const actorId = ALS_SERVICE_INSTANCE.get<string>('actorId');
  if (actorId) {
    info.aId = actorId;
  }

  // Present only while a trace is active, which is only when an OTLP endpoint
  // is configured. These are what let a log line be pivoted to its trace.
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext) {
    info.traceId = spanContext.traceId;
    info.spanId = spanContext.spanId;
  }

  return info;
});

function printLine({
  level = 'info',
  message,
  timestamp,
  ...metadata
}: winston.Logform.TransformableInfo): string {
  const line: LoggerPrintFormat = {
    timestamp: timestamp as string,
    lvl: level.toUpperCase(),
    ctx: (metadata.ctx as string) ?? '',
    msg: message as string,
  };

  // Read in this order deliberately: it fixes the key order of the emitted
  // JSON, which anything parsing stdout may reasonably have come to expect.
  if (metadata.wId) {
    line.wId = metadata.wId as string;
  }

  if (metadata.reqId) {
    line.reqId = metadata.reqId as string;
  }

  if (metadata.opName) {
    line.opName = metadata.opName as string;
  }

  if (metadata.aId) {
    line.aId = metadata.aId as string;
  }

  if (metadata.traceId) {
    line.traceId = metadata.traceId as string;
    line.spanId = metadata.spanId as string;
  }

  // `where` is part of LogInput and callers pass it, but the old formatter
  // never read it, so every value was silently dropped.
  if (metadata.where) {
    line.where = metadata.where as string;
  }

  if (metadata.payload && Object.keys(metadata.payload).length) {
    line.payload = metadata.payload as Record<string, unknown>;
  }

  // `winston.format.errors({ stack: true })` moves a thrown Error's stack onto
  // `metadata.stack`, so it is the fallback when no explicit error was passed.
  const error = serialiseError(metadata.error ?? metadata.stack);
  if (error) {
    line.error = error;
  }

  return JSON.stringify(line);
}

/**
 * Logs are JSON on stdout, always. That is the only sink a container
 * orchestrator collects, and the only format a log pipeline can parse. This
 * used to pretty-print coloured text to the console and emit JSON only to a
 * file behind `CREATE_LOG_FILE`, which put the machine-readable copy in
 * `combined.log` in the working directory — inside the container, where
 * nothing reads it — while the copy that was actually collected could not be
 * parsed.
 *
 * One logger is shared by every context. `new LoggerService('Foo')` is called
 * 27 times across the codebase and each call used to construct its own winston
 * instance with its own transports; the context is per-instance state, the
 * pipeline is not.
 */
const rootLogger: WinstonLogger = createLogger({
  level: config().log.level ?? 'info',
  format: winston.format.combine(
    winston.format.splat(),
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    // Must come before printf: printf terminates the chain by producing the
    // output string, and every transport — including the OTel one — reads the
    // record this leaves behind.
    withCorrelationIds(),
    winston.format.printf(printLine),
  ),
  transports: [new winston.transports.Console()],
});

@Injectable()
export class LoggerService {
  constructor(private readonly context?: string) {}

  /**
   * Nest's internals call these with `(message, stack)` as two plain strings
   * rather than with a `LogInput`, so both shapes have to be accepted. Passing
   * an object straight through as the winston message prints `undefined` and
   * throws away the only part worth reading — which is what used to happen to
   * unhandled exceptions, where the stack matters most.
   */
  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'verbose',
    input: LogInput | string | Error,
    stack?: string,
  ) {
    if (input instanceof Error) {
      rootLogger.log(level, {
        message: input.message,
        ctx: this.context,
        error: input,
      });
      return;
    }

    if (typeof input === 'string') {
      rootLogger.log(level, {
        message: input,
        ctx: this.context,
        ...(stack ? { error: stack } : {}),
      });
      return;
    }

    rootLogger.log(level, { ...input, ctx: this.context });
  }

  log(input: LogInput | string) {
    this.write('info', input);
  }

  info(input: LogInput | string) {
    this.write('info', input);
  }

  error(input: LogInput | string | Error, stack?: string) {
    this.write('error', input, stack);
  }

  warn(input: LogInput | string) {
    this.write('warn', input);
  }

  debug(input: LogInput | string) {
    this.write('debug', input);
  }

  verbose(input: LogInput | string) {
    this.write('verbose', input);
  }
}
