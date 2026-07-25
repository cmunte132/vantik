import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { LoggerService } from 'modules/logger/logger.service';

/**
 * Records server-side exceptions onto the active span, then rethrows.
 *
 * Backend errors previously reached nothing but stdout, and only as a message —
 * the formatter dropped the stack. Attaching them to the span carries the
 * exception into whatever backend the OTLP endpoint points at, next to the
 * trace that produced it.
 *
 * This is an interceptor rather than an exception filter on purpose. A
 * `@Catch()` filter with no arguments matches every exception and, being
 * registered globally, would be consulted ahead of the existing
 * `PrismaClientExceptionFilter` and `SupertokensExceptionFilter` and swallow
 * the cases they exist to handle. Rethrowing from here leaves the response
 * path exactly as it was.
 *
 * Only 5xx and unrecognised exceptions are recorded. A 404 or a validation
 * failure is a normal outcome of a public API, not a server fault, and marking
 * those spans as errors makes the error rate meaningless.
 */
@Injectable()
export class ErrorReportingInterceptor implements NestInterceptor {
  private readonly logger = new LoggerService('UnhandledException');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((exception: unknown) => {
        const status =
          exception instanceof HttpException
            ? exception.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;

        if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
          const error =
            exception instanceof Error
              ? exception
              : new Error(String(exception));

          const span = trace.getActiveSpan();
          if (span) {
            span.recordException(error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
          }

          this.logger.error({
            message: error.message,
            where: `${context.getClass().name}.${context.getHandler().name}`,
            error,
          });
        }

        return throwError(() => exception);
      }),
    );
  }
}
