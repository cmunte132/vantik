import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { SessionContainer } from 'supertokens-node/recipe/session';

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

    const session = request.session as SessionContainer;
    const userId = getAppUserId(session);

    return userId;
  },
);

export const Workspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    const session = request.session as SessionContainer;
    const workspaceId = session.getAccessTokenPayload().workspaceId;

    return workspaceId;
  },
);

/**
 * The personal access token this request came in on, or null for a browser
 * session — which is not issued for any particular token and has none.
 *
 * Per-token limits need to name the token rather than the account: an account
 * can hold several, and a budget spent per account would let one noisy harness
 * exhaust the allowance of every other harness signed in as the same agent.
 */
export const TokenId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    const session = request.session as SessionContainer;

    return session.getAccessTokenPayload().tokenId ?? null;
  },
);

export const Role = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();

    const session = request.session as SessionContainer;
    const role = session.getAccessTokenPayload().role;

    return role;
  },
);
