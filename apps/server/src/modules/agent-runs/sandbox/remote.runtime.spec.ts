import type { SandboxSpec } from '@vantikhq/types';

import { RemoteSandboxRuntime } from './remote.runtime';

const URL_ = 'http://sandbox-host.test:3004';
const TOKEN = 'a-sandbox-host-token-long-enough';

const SPEC: SandboxSpec = {
  runId: 'run-1',
  files: {},
  env: {},
  secrets: {},
  limits: {
    maxDurationMs: 60_000,
    memoryMb: 1024,
    diskMb: 1024,
    cpus: 1,
    maxLogBytes: 1024,
  },
  egress: { allow: [] },
};

type Route = (init: RequestInit) => Response | Promise<Response>;

/** A fetch that answers from a table of `METHOD path` routes. */
function fakeFetch(routes: Record<string, Route | Route[]>) {
  const calls: Array<{ key: string; init: RequestInit }> = [];

  const fetchImpl = jest.fn(async (input: string, init: RequestInit = {}) => {
    const path = input.slice(URL_.length).split('?')[0];
    const key = `${init.method ?? 'GET'} ${path}`;
    calls.push({ key, init });

    const route = routes[key];
    const handler = Array.isArray(route) ? route.shift() : route;

    if (!handler) {
      return json(404, { error: `no route ${key}` });
    }
    return handler(init);
  });

  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runtime(routes: Record<string, Route | Route[]>) {
  const fake = fakeFetch(routes);

  return {
    ...fake,
    runtime: new RemoteSandboxRuntime({
      url: URL_,
      token: TOKEN,
      fetch: fake.fetch,
      keepaliveMs: 1_000,
      retryDelayMs: 0,
    }),
  };
}

const AVAILABLE = () => json(200, { available: true, tier: 'microvm' });
const CREATED = () => json(201, { id: 'sb-1', tier: 'microvm' });

describe('whether hosted execution is available', () => {
  it('is not, and says what to set, when no sandbox host is configured', async () => {
    const availability = await new RemoteSandboxRuntime({
      url: '',
      token: '',
    }).availability();

    expect(availability).toEqual({
      available: false,
      reason: expect.stringContaining('SANDBOX_HOST_URL'),
    });
  });

  it('is not, and names the address, when the sandbox host does not answer', async () => {
    const { runtime: remote } = runtime({
      'GET /v1/availability': () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(remote.availability()).resolves.toEqual({
      available: false,
      reason: expect.stringContaining(URL_),
    });
  });

  it('is not, and blames the token, when the sandbox host refuses it', async () => {
    const { runtime: remote } = runtime({
      'GET /v1/availability': () => json(401, { error: 'no' }),
    });

    await expect(remote.availability()).resolves.toEqual({
      available: false,
      reason: expect.stringContaining('SANDBOX_HOST_TOKEN'),
    });
  });

  it('passes on what the sandbox host says about itself', async () => {
    const { runtime: remote } = runtime({
      'GET /v1/availability': () =>
        json(200, { available: false, reason: 'no qemu-img on its PATH' }),
    });

    await expect(remote.availability()).resolves.toEqual({
      available: false,
      reason: 'no qemu-img on its PATH',
    });
  });

  it('sends the token on every request', async () => {
    const { runtime: remote, calls } = runtime({
      'GET /v1/availability': AVAILABLE,
    });

    await remote.availability();

    expect(calls[0].init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
  });
});

describe('a command', () => {
  it('is started, then polled until it finishes', async () => {
    const { runtime: remote, calls } = runtime({
      'GET /v1/availability': AVAILABLE,
      'POST /v1/sandboxes': CREATED,
      'POST /v1/sandboxes/sb-1/exec': () => json(202, { execId: 'ex-1' }),
      'GET /v1/sandboxes/sb-1/exec/ex-1': [
        () => json(200, { done: false }),
        () => json(200, { done: false }),
        () =>
          json(200, {
            done: true,
            result: { exitCode: 0, stdout: 'ok', stderr: '', egressDenied: 1 },
          }),
      ],
    });

    const sandbox = await remote.create(SPEC);

    await expect(sandbox.exec('pi run', { timeoutMs: 5_000 })).resolves.toEqual(
      { exitCode: 0, stdout: 'ok', stderr: '', egressDenied: 1 },
    );
    expect(
      calls.filter((call) => call.key === 'GET /v1/sandboxes/sb-1/exec/ex-1'),
    ).toHaveLength(3);
    expect(
      JSON.parse(String(calls.find((c) => c.key.endsWith('/exec'))!.init.body)),
    ).toEqual({ command: 'pi run', timeoutMs: 5_000 });

    await sandbox.dispose();
  });

  it('survives a poll that does not reach the sandbox host', async () => {
    const { runtime: remote } = runtime({
      'GET /v1/availability': AVAILABLE,
      'POST /v1/sandboxes': CREATED,
      'POST /v1/sandboxes/sb-1/exec': () => json(202, { execId: 'ex-1' }),
      'GET /v1/sandboxes/sb-1/exec/ex-1': [
        () => {
          throw new TypeError('fetch failed');
        },
        () =>
          json(200, {
            done: true,
            result: { exitCode: 0, stdout: '', stderr: '', egressDenied: 0 },
          }),
      ],
    });

    const sandbox = await remote.create(SPEC);

    await expect(sandbox.exec('true')).resolves.toMatchObject({ exitCode: 0 });
    await sandbox.dispose();
  });

  it('throws when the sandbox host stopped it, as the runtime deadline does', async () => {
    const { runtime: remote } = runtime({
      'GET /v1/availability': AVAILABLE,
      'POST /v1/sandboxes': CREATED,
      'POST /v1/sandboxes/sb-1/exec': () => json(202, { execId: 'ex-1' }),
      'GET /v1/sandboxes/sb-1/exec/ex-1': () =>
        json(200, { done: true, error: 'The operation was aborted' }),
    });

    const sandbox = await remote.create(SPEC);

    await expect(sandbox.exec('sleep 99')).rejects.toThrow('aborted');
    await sandbox.dispose();
  });

  it('gives up at once when the sandbox is gone', async () => {
    const { runtime: remote, calls } = runtime({
      'GET /v1/availability': AVAILABLE,
      'POST /v1/sandboxes': CREATED,
      'POST /v1/sandboxes/sb-1/exec': () => json(202, { execId: 'ex-1' }),
      'GET /v1/sandboxes/sb-1/exec/ex-1': () =>
        json(404, { error: 'No sandbox sb-1' }),
    });

    const sandbox = await remote.create(SPEC);

    await expect(sandbox.exec('true')).rejects.toThrow('No sandbox sb-1');
    expect(
      calls.filter((call) =>
        call.key.startsWith('GET /v1/sandboxes/sb-1/exec'),
      ),
    ).toHaveLength(1);
    await sandbox.dispose();
  });
});

describe('disposal', () => {
  it('happens once, and never throws', async () => {
    const { runtime: remote, calls } = runtime({
      'GET /v1/availability': AVAILABLE,
      'POST /v1/sandboxes': CREATED,
      'DELETE /v1/sandboxes/sb-1': () => {
        throw new TypeError('fetch failed');
      },
    });

    const sandbox = await remote.create(SPEC);

    await expect(sandbox.dispose()).resolves.toBeUndefined();
    await expect(sandbox.dispose()).resolves.toBeUndefined();
    expect(calls.filter((call) => call.key.startsWith('DELETE'))).toHaveLength(
      1,
    );
  });

  it('stops the keepalives that hold the sandbox open', async () => {
    jest.useFakeTimers();

    try {
      const { runtime: remote, calls } = runtime({
        'GET /v1/availability': AVAILABLE,
        'POST /v1/sandboxes': CREATED,
        'POST /v1/sandboxes/sb-1/keepalive': () =>
          new Response(null, { status: 204 }),
        'DELETE /v1/sandboxes/sb-1': () => new Response(null, { status: 204 }),
      });

      const sandbox = await remote.create(SPEC);
      await jest.advanceTimersByTimeAsync(3_500);

      const alive = calls.filter((call) => call.key.endsWith('/keepalive'));
      expect(alive).toHaveLength(3);

      await sandbox.dispose();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(
        calls.filter((call) => call.key.endsWith('/keepalive')),
      ).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
