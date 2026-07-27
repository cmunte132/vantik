/**
 * Runtime settings, fetched from the server instead of baked into the bundle.
 *
 * Self-hosted installs set these when the container starts, long after the
 * image was built, so they cannot be inlined at build time. They used to be
 * carried by `publicRuntimeConfig` plus a sed pass over .next at boot; now the
 * browser just asks for them over the same-origin /api proxy.
 */
export interface ClientConfig {
  socketHost: string;
  posthogKey: string;
  posthogHost: string;
  sentryDsn: string;
  /** Whether this install has an LLM endpoint configured. */
  aiEnabled: boolean;
}

const FALLBACK: ClientConfig = {
  socketHost: '',
  posthogKey: '',
  posthogHost: 'https://us.i.posthog.com',
  sentryDsn: '',
  // Off until the server says otherwise, so an install without an endpoint
  // never flashes an AI affordance that would fail when pressed.
  aiEnabled: false,
};

// Parked on window rather than in module scope because the instrumentation
// bundle and the app bundle each get their own copy of this module; a
// module-level promise would let them fetch the same config twice.
const CACHE_KEY = '__vantikClientConfig';

interface ConfigWindow extends Window {
  [CACHE_KEY]?: Promise<ClientConfig>;
}

/**
 * How many times one call tries before it settles for the fallback.
 *
 * The first request goes out while the page is still booting, which is exactly
 * when a self-hosted install is least likely to answer it: the browser can
 * reach the webapp container a moment before the server container is listening.
 * Attempts are spaced 0.5s, 1s, 2s, so a boot that is a few seconds behind is
 * ridden out rather than reported.
 */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestClientConfig(): Promise<ClientConfig> {
  const response = await fetch('/api/v1/config');

  if (!response.ok) {
    throw new Error(`Config request failed: ${response.status}`);
  }

  const config = (await response.json()) as Partial<ClientConfig>;

  return { ...FALLBACK, ...config };
}

/**
 * Fetches the config once per page load. Concurrent callers share the request,
 * and the resolved value is cached for the synchronous readers below.
 *
 * Only a *success* is cached. A failure used to be, which made one unlucky
 * request degrade the tab for as long as it stayed open: every later caller was
 * handed the same rejected attempt's fallback, and nothing short of a reload
 * could recover. Since the fallback carries no socketHost, that cost the page
 * its live updates — see socket-data-sync.
 */
export function loadClientConfig(): Promise<ClientConfig> {
  if (typeof window === 'undefined') {
    return Promise.resolve(FALLBACK);
  }

  const cache = window as ConfigWindow;

  if (!cache[CACHE_KEY]) {
    cache[CACHE_KEY] = attemptLoad(cache);
  }

  return cache[CACHE_KEY];
}

async function attemptLoad(cache: ConfigWindow): Promise<ClientConfig> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const config = await requestClientConfig();
      cachedConfig = config;

      return config;
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        // Not console.error: an attempt that is about to be retried is not yet
        // a failure, and reporting it as one puts a red card over the app in
        // development for something that resolves itself a second later.
        // eslint-disable-next-line no-console
        console.warn(
          `Runtime config attempt ${attempt} failed, retrying`,
          error,
        );

        await delay(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }

      // A missing config must not take the whole app down; the features that
      // depend on it degrade individually.
      // eslint-disable-next-line no-console
      console.error('Failed to load runtime config', error);
    }
  }

  // Drop the cache entry rather than leaving the failure in it, so the next
  // caller starts a fresh attempt instead of inheriting this one. Callers
  // already holding this promise still get the fallback; nothing rejects.
  delete cache[CACHE_KEY];

  return FALLBACK;
}

let cachedConfig: ClientConfig | undefined;

/**
 * The already-resolved config, for callers that cannot await. Returns
 * undefined until the fetch started by loadClientConfig() lands.
 */
export function getLoadedClientConfig(): ClientConfig | undefined {
  return cachedConfig;
}
