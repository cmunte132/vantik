import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

import { SERVER_BUILD } from 'common/build-stamp';

/**
 * Stamps every response with the server image's build.
 *
 * The webapp and the server are separate images with separate versions, so this
 * is deliberately a *different* header from the `X-Vantik-Build` the webapp sets
 * on its own responses. A client compares itself against the webapp's stamp; it
 * reads this one only to make skew visible.
 *
 * Advertising only, by design. Nothing on this side reads a client's version or
 * refuses a request because of it — an old client gets a working API, and the
 * contract is that changes here stay backward compatible.
 */
@Injectable()
export class BuildStampInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Skips anything that is not HTTP — the websocket gateway announces its
    // version over the socket instead.
    if (context.getType() === 'http') {
      context
        .switchToHttp()
        .getResponse()
        ?.setHeader?.('X-Vantik-Server-Build', SERVER_BUILD);
    }

    return next.handle();
  }
}
