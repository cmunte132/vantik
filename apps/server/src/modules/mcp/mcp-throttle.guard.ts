import { createHash } from 'crypto';

import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import {
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerOptions,
} from '@nestjs/throttler';
import { Response } from 'express';

import { bearerToken } from 'common/pat-session';

/** Requests one token may make per window before it starts getting 429s. */
export const DEFAULT_MCP_RATE_LIMIT = 120;

/** Length of that window, in milliseconds. */
export const DEFAULT_MCP_RATE_WINDOW_MS = 60_000;

/**
 * Reads the limit from the environment so an operator can tune it without a
 * rebuild. `MCP_RATE_LIMIT=0` turns the limit off entirely, which is the escape
 * hatch for anyone who fronts the endpoint with their own limiter — the
 * throttler reads a limit of zero as "reject everything", so that case has to
 * skip the check rather than be passed through as a budget.
 */
export function mcpThrottlerOptions(): ThrottlerOptions {
  const limit = readNumber(process.env.MCP_RATE_LIMIT, DEFAULT_MCP_RATE_LIMIT);
  const ttl = readNumber(
    process.env.MCP_RATE_LIMIT_WINDOW_MS,
    DEFAULT_MCP_RATE_WINDOW_MS,
  );

  return { name: 'mcp', limit, ttl, skipIf: () => limit === 0 };
}

function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Rate limits the MCP endpoint per personal access token.
 *
 * Per-user throttling has nothing to key on this early and per-IP throttling
 * would lump every agent behind one NAT together, so the token is what we count
 * against: one runaway agent gets throttled without touching anybody else's.
 *
 * This only works because AuthGuard runs first and rejects a token that does not
 * resolve to an account. Counting an *unverified* token would hand the limit its
 * own bypass — a caller inventing a new `tg_pat_…` string per request gets a
 * fresh, empty bucket every time — so anything that reaches here without a
 * session is counted by address instead.
 *
 * Counters live in the throttler's in-memory store, which means the limit is
 * per process. With several replicas the effective ceiling is the limit times
 * the number of replicas — enough to stop a runaway loop, not a quota system.
 */
@Injectable()
export class McpThrottleGuard extends ThrottlerGuard {
  /**
   * Takes the MCP budget rather than the app-wide one.
   *
   * ThrottlerModule is `@Global()`, so importing a second `forRoot` in McpModule
   * does not scope anything — the app-level registration wins and the endpoint
   * silently ran on its 10-per-minute default, which is a browser budget, not an
   * agent's. Replacing the resolved throttlers here is what actually holds.
   */
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = [mcpThrottlerOptions()];
  }

  /**
   * Tokens are secrets, and the tracker ends up in storage keys and in the
   * limit detail passed to error handling, so hash it rather than carrying the
   * token around.
   *
   * A token is only counted once AuthGuard has vouched for it, which it signals
   * by putting a session on the request. Without one — an unauthenticated
   * request, or a token nobody holds — the address is the bucket, so no amount
   * of inventing token strings buys a caller more budget.
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const token = bearerToken(
      (req.headers as Record<string, string>)?.authorization,
    );

    if (!token || !req.session) {
      return `address:${(req.ip as string) ?? 'unknown'}`;
    }

    return createHash('sha256').update(token).digest('hex').slice(0, 32);
  }

  /**
   * The default exception body is plain HTTP, which a JSON-RPC client cannot
   * read. Answer in the protocol the caller is speaking - 429 for anything
   * looking at the transport, a JSON-RPC error for the client itself - and say
   * how long to wait.
   *
   * It has to *throw*: `ThrottlerGuard.handleRequest` calls this and then keeps
   * going, so writing the response here and returning left the guard answering
   * true — the throttled request went on to run the handler against a response
   * that had already been sent. Throwing is what stops it, and Nest serialises
   * an object body as-is, so the JSON-RPC shape survives.
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response: Response = context.switchToHttp().getResponse();
    const retryAfter = Math.ceil(detail.timeToBlockExpire);

    response.setHeader('Retry-After', retryAfter);

    throw new HttpException(
      {
        jsonrpc: '2.0',
        error: {
          code: -32029,
          message: `Rate limit exceeded for this token. Retry in ${retryAfter}s.`,
          data: { retryAfter, limit: detail.limit },
        },
        id: null,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
