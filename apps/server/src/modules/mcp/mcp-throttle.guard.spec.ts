import { createHash } from 'crypto';

import { HttpException } from '@nestjs/common';

import {
  DEFAULT_MCP_RATE_LIMIT,
  DEFAULT_MCP_RATE_WINDOW_MS,
  McpThrottleGuard,
  mcpThrottlerOptions,
} from './mcp-throttle.guard';

/** Everything the tests reach for is protected on purpose; open it up here. */
class TestGuard extends McpThrottleGuard {
  track(req: Record<string, unknown>) {
    return this.getTracker(req);
  }

  configured() {
    return this.throttlers;
  }

  reject(context: unknown, detail: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.throwThrottlingException(context as any, detail as any);
  }
}

function guard() {
  // These read only the request, so the guard's collaborators can stay
  // unresolved here rather than dragging a Nest module into the test.
  return new TestGuard(
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

/** Restores whatever the environment was before a test tuned the limit. */
function restoreEnvAfterEach() {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });
}

/**
 * A request as the guard sees it once AuthGuard has run: a session on the
 * request is how the guard knows the token was actually vouched for.
 */
function request(authorization?: string, ip = '10.0.0.1') {
  return {
    headers: authorization ? { authorization } : {},
    ip,
    session: authorization ? {} : undefined,
  };
}

/** A request carrying a token nobody holds — no session was ever put on it. */
function unverified(authorization: string, ip = '10.0.0.1') {
  return { headers: { authorization }, ip };
}

describe('mcpThrottlerOptions', () => {
  restoreEnvAfterEach();

  it('falls back to the defaults when nothing is configured', () => {
    delete process.env.MCP_RATE_LIMIT;
    delete process.env.MCP_RATE_LIMIT_WINDOW_MS;

    const options = mcpThrottlerOptions();

    expect(options.name).toBe('mcp');
    expect(options.limit).toBe(DEFAULT_MCP_RATE_LIMIT);
    expect(options.ttl).toBe(DEFAULT_MCP_RATE_WINDOW_MS);
  });

  it('takes the limit and the window from the environment', () => {
    process.env.MCP_RATE_LIMIT = '5';
    process.env.MCP_RATE_LIMIT_WINDOW_MS = '1000';

    const options = mcpThrottlerOptions();

    expect(options.limit).toBe(5);
    expect(options.ttl).toBe(1000);
  });

  it('ignores values that are not usable numbers', () => {
    process.env.MCP_RATE_LIMIT = 'lots';
    process.env.MCP_RATE_LIMIT_WINDOW_MS = '-1';

    const options = mcpThrottlerOptions();

    expect(options.limit).toBe(DEFAULT_MCP_RATE_LIMIT);
    expect(options.ttl).toBe(DEFAULT_MCP_RATE_WINDOW_MS);
  });

  it('skips the check at zero rather than rejecting everything', () => {
    process.env.MCP_RATE_LIMIT = '0';

    const options = mcpThrottlerOptions();

    expect(options.skipIf?.(undefined as never)).toBe(true);
  });

  it('does not skip the check at a real limit', () => {
    process.env.MCP_RATE_LIMIT = '5';

    expect(mcpThrottlerOptions().skipIf?.(undefined as never)).toBe(false);
  });
});

describe('McpThrottleGuard configuration', () => {
  restoreEnvAfterEach();

  it('uses the MCP budget, not the app-wide throttler it inherits', async () => {
    process.env.MCP_RATE_LIMIT = '77';
    const subject = guard();

    // What the globally registered ThrottlerModule would otherwise leave here:
    // a browser-sized budget that would throttle an agent within seconds.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (subject as any).options = [{ ttl: 60_000, limit: 10 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (subject as any).storageService = {};

    await subject.onModuleInit();

    expect(subject.configured()).toHaveLength(1);
    expect(subject.configured()[0].limit).toBe(77);
    expect(subject.configured()[0].name).toBe('mcp');
  });
});

describe('McpThrottleGuard.getTracker', () => {
  it('keys on the token, so two agents get separate budgets', async () => {
    const subject = guard();

    const one = await subject.track(request('Bearer tg_pat_one'));
    const two = await subject.track(request('Bearer tg_pat_two'));

    expect(one).not.toEqual(two);
  });

  it('gives the same token the same bucket across requests', async () => {
    const subject = guard();

    expect(await subject.track(request('Bearer tg_pat_one'))).toEqual(
      await subject.track(request('Bearer tg_pat_one')),
    );
  });

  it('hashes the token rather than storing it', async () => {
    const tracker = await guard().track(request('Bearer tg_pat_secret'));

    expect(tracker).not.toContain('tg_pat_secret');
    expect(tracker).toEqual(
      createHash('sha256').update('tg_pat_secret').digest('hex').slice(0, 32),
    );
  });

  it('falls back to the address when there is no token', async () => {
    const subject = guard();

    expect(await subject.track(request())).toBe('address:10.0.0.1');
    expect(await subject.track(request('Basic nope'))).toBe('address:10.0.0.1');
  });

  /**
   * The bypass this closes: counting a token nobody has vouched for lets a
   * caller invent a new one per request and start from an empty bucket each
   * time. Unverified traffic is counted by address, which it cannot rotate.
   */
  it('does not give an unverified token a budget of its own', async () => {
    const subject = guard();

    const first = await subject.track(unverified('Bearer tg_pat_made_up_1'));
    const second = await subject.track(unverified('Bearer tg_pat_made_up_2'));

    expect(first).toBe('address:10.0.0.1');
    expect(second).toBe(first);
  });
});

/**
 * ThrottlerGuard.handleRequest calls this and then carries on to set headers
 * and answer true, so writing the response here instead of throwing let a
 * throttled request run the handler against a response already sent.
 */
describe('McpThrottleGuard.throwThrottlingException', () => {
  function contextWith(response: Record<string, unknown>) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
        getResponse: () => response,
      }),
    };
  }

  it('throws, so a throttled request never reaches the handler', async () => {
    const sent: string[] = [];
    const response = {
      setHeader: (name: string): number => sent.push(name),
      status: () => {
        sent.push('status');
        return response;
      },
      json: () => {
        sent.push('json');
        return response;
      },
    };

    await expect(
      guard().reject(contextWith(response), {
        limit: 120,
        timeToBlockExpire: 4.2,
      }),
    ).rejects.toBeInstanceOf(HttpException);

    // The body is Nest's to serialise; the guard only sets Retry-After.
    expect(sent).toEqual(['Retry-After']);
  });

  it('answers in JSON-RPC, at 429, saying how long to wait', async () => {
    const response = { setHeader: (): void => undefined };

    let error: HttpException | null = null;
    try {
      await guard().reject(contextWith(response), {
        limit: 120,
        timeToBlockExpire: 4.2,
      });
    } catch (thrown) {
      error = thrown as HttpException;
    }

    expect(error?.getStatus()).toBe(429);
    expect(error?.getResponse()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32029,
        message: expect.stringContaining('Retry in 5s'),
        data: { retryAfter: 5, limit: 120 },
      },
    });
  });
});
