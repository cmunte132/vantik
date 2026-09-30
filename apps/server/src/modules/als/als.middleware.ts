import { Injectable, NestMiddleware } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { trace } from '@opentelemetry/api';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { hasValidPat } from 'common/authentication';
import { bearerToken, isPatToken } from 'common/pat-session';

import { AuthSessionContext } from 'modules/auth/auth.interface';
import { AuthService, sessionTokenFromRequest } from 'modules/auth/auth.service';
import { UsersService } from 'modules/users/users.service';

import { ALSService } from './als.service';

function resolveRequestId(inbound: string | string[] | undefined): string {
  const header = Array.isArray(inbound) ? inbound[0] : inbound;
  if (header?.length) {
    return header;
  }

  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  return traceId ?? uuidv4();
}

@Injectable()
export class ALSMiddleware implements NestMiddleware {
  constructor(
    private readonly als: ALSService,
    private readonly authService: AuthService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const requestId = resolveRequestId(req.headers['x-request-id']);
    req.headers['x-request-id'] = requestId;

    res.setHeader('x-request-id', requestId);

    // An explicit bearer token takes priority over the cookie.
    const token = bearerToken(req.headers.authorization);
    let session: AuthSessionContext | null = null;
    if (isPatToken(token)) {
      const usersService = await this.moduleRef.resolve(UsersService, undefined, {
        strict: false,
      });
      const request = req as Request & { session?: AuthSessionContext };
      if (await hasValidPat(request, usersService)) {
        session = request.session ?? null;
      }
    } else {
      const sessionToken = token ?? sessionTokenFromRequest(req);
      if (sessionToken) {
        session = await this.authService.resolveRequestSession(
          req,
          sessionToken,
          token ? undefined : res,
        );
      }
    }

    const store: Map<string, unknown> = new Map();

    store.set('opName', req.baseUrl);
    store.set('ipAddress', req.headers['x-forwarded-for']);
    store.set('requestId', requestId);
    if (session) {
      (req as Request & { session?: AuthSessionContext }).session = session;
      store.set('actorId', session.getUserId());
      const { workspaceId } = session.getAccessTokenPayload();
      if (workspaceId) {
        store.set('workspaceId', workspaceId);
      }
    }

    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute('request.id', requestId);
      const workspaceId = store.get('workspaceId') as string | undefined;
      if (workspaceId) {
        span.setAttribute('vantik.workspace_id', workspaceId);
      }
      const actorId = store.get('actorId') as string | undefined;
      if (actorId) {
        span.setAttribute('vantik.actor_id', actorId);
      }
    }

    this.als.run(store, () => {
      next();
    });
  }
}
