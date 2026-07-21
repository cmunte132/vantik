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
}

const FALLBACK: ClientConfig = {
  socketHost: '',
  posthogKey: '',
  posthogHost: 'https://us.i.posthog.com',
  sentryDsn: '',
};

// Parked on window rather than in module scope because the instrumentation
// bundle and the app bundle each get their own copy of this module; a
// module-level promise would let them fetch the same config twice.
const CACHE_KEY = '__vantikClientConfig';

interface ConfigWindow extends Window {
  [CACHE_KEY]?: Promise<ClientConfig>;
}

/**
 * Fetches the config once per page load. Concurrent callers share the request,
 * and the resolved value is cached for the synchronous readers below.
 */
export function loadClientConfig(): Promise<ClientConfig> {
  if (typeof window === 'undefined') {
    return Promise.resolve(FALLBACK);
  }

  const cache = window as ConfigWindow;

  if (!cache[CACHE_KEY]) {
    cache[CACHE_KEY] = fetch('/api/v1/config')
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Config request failed: ${response.status}`);
        }

        return response.json();
      })
      .then((config: Partial<ClientConfig>) => {
        const resolved = { ...FALLBACK, ...config };
        cachedConfig = resolved;

        return resolved;
      })
      .catch((error) => {
        // A missing config must not take the whole app down; the features that
        // depend on it degrade individually.
        // eslint-disable-next-line no-console
        console.error('Failed to load runtime config', error);

        return FALLBACK;
      });
  }

  return cache[CACHE_KEY];
}

let cachedConfig: ClientConfig | undefined;

/**
 * The already-resolved config, for callers that cannot await. Returns
 * undefined until the fetch started by loadClientConfig() lands.
 */
export function getLoadedClientConfig(): ClientConfig | undefined {
  return cachedConfig;
}
