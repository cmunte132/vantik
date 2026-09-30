import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthSessionContext } from 'modules/auth/auth.interface';
import { getAppUserId } from 'modules/auth/session-user';

export const Session = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    return request.session;
  },
);

export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    const session = request.session as AuthSessionContext;
    const userId = getAppUserId(session);

    return userId;
  },
);

export const Workspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    const session = request.session as AuthSessionContext;
    const workspaceId = session?.getAccessTokenPayload?.()?.workspaceId;
    if (!workspaceId) {
      throw new UnauthorizedException({
        message: 'No workspace is associated with this session',
      });
    }

    return workspaceId;
  },
);

export const TokenId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    const session = request.session as AuthSessionContext;

    return session?.getAccessTokenPayload?.()?.tokenId ?? null;
  },
);

export const Role = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    const session = request.session as AuthSessionContext;
    const role = session?.getAccessTokenPayload?.()?.role;

    return role;
  },
);
