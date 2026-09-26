import { VantikApiError, VantikAuthError } from './errors';

export interface VantikClientConfig {
  /**
   * Root of the Vantik API. Point this at the server itself
   * (`http://localhost:3001` in the default docker compose) or at the webapp's
   * proxy (`https://vantik.example.com/api`). The `/v1` version segment is
   * added for you.
   */
  baseUrl?: string;
  /** Personal access token — the `tg_pat_…` value from Settings → API. */
  token?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
}

const DEFAULT_BASE_URL = 'http://localhost:3001';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thin authenticated HTTP client over the Vantik REST API.
 *
 * It knows about transport, auth and error shapes — nothing about tasks. The
 * task vocabulary lives in `VantikAgent`, so both the CLI and the MCP server
 * get identical behaviour from one implementation.
 */
export class VantikClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: VantikClientConfig = {}) {
    const baseUrl =
      config.baseUrl ?? process.env.VANTIK_URL ?? DEFAULT_BASE_URL;
    const token = config.token ?? process.env.VANTIK_TOKEN ?? '';

    if (!token) {
      throw new VantikAuthError(
        'No Vantik personal access token. Set VANTIK_TOKEN (or pass `token`) ' +
          'to a `tg_pat_…` value created under Settings → API.',
      );
    }

    let normalizedUrl = baseUrl;
    while (normalizedUrl.endsWith('/')) {
      normalizedUrl = normalizedUrl.slice(0, -1);
    }
    this.baseUrl = normalizedUrl;
    this.token = token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  private async request<T>(
    method: string,
    path: string,
    { query, body }: RequestOptions,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new VantikApiError(
          408,
          method,
          path,
          `no response within ${this.timeoutMs}ms — is Vantik running at ${this.baseUrl}?`,
        );
      }
      throw new VantikApiError(
        0,
        method,
        path,
        `could not reach ${this.baseUrl}: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    // 401 only. A 403 is the server saying *this* call is not allowed — an
    // agent reaching past its scopes, or a resource in another workspace — and
    // it explains itself in the body. Folding it in here threw that explanation
    // away and told the caller to mint a new token, which is advice that cannot
    // work: the reader is usually a model, and it would loop on it.
    if (response.status === 401) {
      throw new VantikAuthError(
        'Vantik rejected the personal access token (401). It may have been ' +
          'revoked — create a new one under Settings → Agents.',
      );
    }

    if (!response.ok) {
      throw new VantikApiError(
        response.status,
        method,
        path,
        await response.text().catch(() => ''),
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new VantikApiError(
        response.status,
        method,
        path,
        `expected JSON, got: ${text.slice(0, 200)}`,
      );
    }
  }
}
