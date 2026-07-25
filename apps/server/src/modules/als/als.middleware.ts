import { Injectable, NestMiddleware } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { Request, Response, NextFunction } from 'express';
import Session from 'supertokens-node/recipe/session';
import { v4 as uuidv4 } from 'uuid';

import { getAppUserId } from 'modules/auth/session-user';

import { ALSService } from './als.service';

/**
 * Resolve the id that identifies this request everywhere: response header,
 * every log line, and the trace.
 *
 * An inbound `x-request-id` always wins — it is how a caller ties our logs
 * back to its own. Otherwise the active trace id is used verbatim rather than
 * minting a separate uuid, so the request id and the trace id are one
 * identifier instead of two that have to be joined by hand. The uuid remains
 * the fallback for when no OTLP endpoint is configured and there is no trace.
 */
function resolveRequestId(inbound: string | string[] | undefined): string {
  // Express hands back an array when a header is sent more than once.
  const header = Array.isArray(inbound) ? inbound[0] : inbound;
  if (header?.length) {
    return header;
  }

  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  return traceId ?? uuidv4();
}

@Injectable()
export class ALSMiddleware implements NestMiddleware {
  constructor(private readonly als: ALSService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const requestId = resolveRequestId(req.headers['x-request-id']);
    req.headers['x-request-id'] = requestId;

    // Set before the handler chain runs. Setting it afterwards races the
    // response: any handler that finishes synchronously has already flushed
    // its headers by the time we get back here.
    res.setHeader('x-request-id', requestId);

    const session = await Session.getSession(req, res, {
      sessionRequired: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: Map<string, any> = new Map();

    store.set('opName', req.baseUrl);
    store.set('ipAddress', req.headers['x-forwarded-for']);
    store.set('requestId', requestId);
    if (session) {
      store.set('actorId', getAppUserId(session));
      store.set('workspaceId', session.getTenantId());
    }

    // Mirror the correlation ids onto the span so a trace can be found from a
    // request id, and so traces can be filtered by workspace or actor. No-ops
    // when no OTLP endpoint is configured, since there is no active span.
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute('request.id', requestId);
      const workspaceId = store.get('workspaceId');
      if (workspaceId) {
        span.setAttribute('vantik.workspace_id', workspaceId);
      }
      const actorId = store.get('actorId');
      if (actorId) {
        span.setAttribute('vantik.actor_id', actorId);
      }
    }

    this.als.run(store, () => {
      next();
    });
  }
}
