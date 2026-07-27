/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * What a failed config fetch is allowed to cost.
 *
 * The bug worth pinning is not the request failing — that is expected on a
 * self-hosted boot, where the browser can reach the webapp a moment before the
 * server is listening. It is that the failure used to be cached, so a single
 * unlucky request degraded the tab until it was reloaded: no socket host, so no
 * live updates, with nothing on screen to say so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CACHE_KEY = '__vantikClientConfig';

/**
 * A page load creates the module's own state and the window it caches on at the
 * same moment, so a test that stubs a fresh window has to take a fresh module
 * with it. Sharing one import instead leaks `cachedConfig` between tests.
 */
async function freshModule() {
  vi.resetModules();

  return import('./client-config');
}

const SERVED = {
  socketHost: 'http://localhost:3001',
  posthogKey: 'phc_test',
  posthogHost: 'https://us.i.posthog.com',
  sentryDsn: '',
  aiEnabled: true,
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function status(code: number) {
  return {
    ok: false,
    status: code,
    json: async () => ({}),
  } as Response;
}

describe('loadClientConfig', () => {
  beforeEach(() => {
    // The module reads `window` only through this key, so a bare object is
    // enough to run in the node environment the rest of the suite uses.
    vi.stubGlobal('window', {} as Window);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('caches a success and serves later callers from it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(SERVED));
    vi.stubGlobal('fetch', fetchMock);
    const { loadClientConfig, getLoadedClientConfig } = await freshModule();

    expect(await loadClientConfig()).toMatchObject(SERVED);
    expect(await loadClientConfig()).toMatchObject(SERVED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLoadedClientConfig()).toMatchObject(SERVED);
  });

  it('rides out a boot that is a few seconds behind', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(status(401))
      .mockResolvedValue(ok(SERVED));
    vi.stubGlobal('fetch', fetchMock);
    const { loadClientConfig } = await freshModule();

    const loaded = loadClientConfig();
    await vi.runAllTimersAsync();

    expect(await loaded).toMatchObject(SERVED);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back without rejecting once the attempts run out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(status(401)));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadClientConfig, getLoadedClientConfig } = await freshModule();

    const loaded = loadClientConfig();
    await vi.runAllTimersAsync();

    // The fallback, not a rejection: callers degrade one feature at a time
    // rather than the page failing to boot.
    expect(await loaded).toMatchObject({ socketHost: '', aiEnabled: false });
    expect(error).toHaveBeenCalledOnce();
    // Nothing to hand the synchronous readers: false is not a known answer.
    expect(getLoadedClientConfig()).toBeUndefined();
  });

  it('does not cache a failure, so the next caller tries again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(401));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadClientConfig, getLoadedClientConfig } = await freshModule();

    const failed = loadClientConfig();
    await vi.runAllTimersAsync();
    await failed;

    expect(
      (window as unknown as Record<string, unknown>)[CACHE_KEY],
    ).toBeUndefined();

    fetchMock.mockResolvedValue(ok(SERVED));
    const retried = loadClientConfig();
    await vi.runAllTimersAsync();

    // The whole point: the tab recovers on its own once the server answers,
    // instead of holding the first failure until someone reloads it.
    expect(await retried).toMatchObject(SERVED);
    expect(getLoadedClientConfig()).toMatchObject(SERVED);
  });
});
