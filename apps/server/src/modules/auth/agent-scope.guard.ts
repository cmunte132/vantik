import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AgentScope, RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import {
  bearerToken,
  isPatToken,
  resolvePatPrincipal,
  touchToken,
} from 'common/pat-session';

import {
  agentSettings,
  REQUIRED_AGENT_SCOPE,
  requiredScopeFor,
  SKIP_AGENT_SCOPE,
} from './agent-scope';

/**
 * Holds agents to the scopes they were granted.
 *
 * Role was barely enforced before this: only AdminGuard looked at it, so an
 * AGENT could do anything a member could — including delete. An agent runs on
 * its own judgment at a speed nobody is watching, which is exactly the
 * principal that should not hold irreversible verbs by default.
 *
 * It resolves the caller itself rather than reading `request.session`, because
 * a globally registered guard runs before the route's own AuthGuard has
 * populated that. It can: an agent authenticates only by personal access token,
 * so the token on the request is enough to find its membership. Requests that
 * carry no token are people, and people are not scoped here. The lookup is
 * cached on the request, so authenticating the same token costs nothing again.
 *
 * This is authorisation, not authentication — a bad token still falls to
 * AuthGuard afterwards. A token that resolves to nothing simply passes through.
 */
@Injectable()
export class AgentScopeGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AGENT_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skip) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = bearerToken(request.headers?.authorization);

    if (!isPatToken(token)) {
      return true;
    }

    const principal = await resolvePatPrincipal(this.prisma, token, request);
    const membership = principal?.membership;

    // A person's token, a revoked one, or one whose membership is gone: not an
    // agent, so not this guard's business. A token nobody holds still falls to
    // AuthGuard afterwards.
    if (membership?.role !== RoleEnum.AGENT) {
      return true;
    }

    // The one place every authenticated agent request already passes through
    // with its token row resolved, which is what makes "has this agent ever
    // been used" answerable without a second lookup. Throttled and not awaited
    // — see `touchToken`.
    touchToken(this.prisma, principal);

    const { scopes: granted } = agentSettings(membership.settings);
    const needed =
      this.reflector.getAllAndOverride<AgentScope>(REQUIRED_AGENT_SCOPE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? requiredScopeFor(request.method);

    if (!granted.includes(needed)) {
      throw new ForbiddenException(
        `This agent does not have the "${needed}" scope. It was granted: ${granted.join(', ')}.`,
      );
    }

    return true;
  }
}
