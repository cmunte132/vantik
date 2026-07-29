import { type ModelProvider } from '@vantikhq/types';

/** One model a key can reach, reduced to what a person choosing needs. */
export interface CatalogueModel {
  id: string;
  label: string;
}

export type CatalogueResult =
  /** The provider answered, and this is what the key gets. */
  | { outcome: 'ok'; models: CatalogueModel[] }
  /** The provider refused the key. Nothing is stored on this answer. */
  | { outcome: 'rejected'; message: string }
  /** No list, for a reason that says nothing about whether the key is good. */
  | { outcome: 'unknown'; message: string };

/**
 * Asks a provider what a key can reach.
 *
 * This is the whole point of the settings screen knowing about providers: a
 * person pasting a key finds out immediately whether it works and what it
 * buys them, rather than finding out from a failed run an hour later.
 *
 * The three outcomes are deliberately not two. A refused key and an
 * unreachable provider look the same to a naive caller and mean opposite
 * things — one is the person's mistake and one is not — so a network problem
 * must never be reported as a bad key, and a bad key must never be stored as
 * though it were fine.
 */
export async function fetchCatalogue(
  provider: ModelProvider,
  secret: string,
  baseUrl?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogueResult> {
  if (!provider.catalogue) {
    return {
      outcome: 'unknown',
      message: `${provider.label} does not publish a model list, so the model has to be typed.`,
    };
  }

  // Some providers publish their catalogue to anyone, so listing it proves
  // nothing about the key. Where there is an endpoint that does require one,
  // it is asked first — otherwise "check the key" checks only that the
  // provider is up.
  if (provider.catalogue.verifyUrl) {
    const verdict = await ask(
      provider,
      provider.catalogue.verifyUrl,
      secret,
      baseUrl,
      fetchImpl,
    );

    if (verdict.outcome !== 'ok') {
      return verdict.outcome === 'rejected'
        ? verdict
        : { outcome: 'unknown', message: verdict.message };
    }
  }

  const asked = await ask(
    provider,
    provider.catalogue.url,
    secret,
    baseUrl,
    fetchImpl,
  );

  if (asked.outcome !== 'ok') {
    return asked;
  }

  const response = asked.response;

  try {
    return { outcome: 'ok', models: parseModels(await response.json()) };
  } catch (error) {
    return {
      outcome: 'unknown',
      message: `${provider.label} sent a model list this version cannot read: ${(error as Error).message}`,
    };
  }
}

/**
 * One authenticated request to a provider, classified.
 *
 * The three outcomes are decided here so the verify call and the list call
 * cannot disagree about what a 401 or a timeout means.
 */
async function ask(
  provider: ModelProvider,
  target: string,
  secret: string,
  baseUrl: string | null | undefined,
  fetchImpl: typeof fetch,
): Promise<
  | { outcome: 'ok'; response: Response }
  | { outcome: 'rejected'; message: string }
  | { outcome: 'unknown'; message: string }
> {
  const { url, headers } = requestFor(provider, target, secret, baseUrl);

  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers,
      // A settings form is waiting on this. A provider that has not answered
      // in ten seconds is not going to make the page more useful by answering
      // in sixty.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      outcome: 'unknown',
      // The URL is deliberately absent: for a `query` provider it carries the
      // key.
      message: `Could not reach ${provider.label}: ${(error as Error).message}`,
    };
  }

  const rejects = [401, 403, ...(provider.catalogue?.rejectStatuses ?? [])];

  if (rejects.includes(response.status)) {
    return {
      outcome: 'rejected',
      message: `${provider.label} refused this key.`,
    };
  }

  if (!response.ok) {
    return {
      outcome: 'unknown',
      message: `${provider.label} answered ${response.status}.`,
    };
  }

  return { outcome: 'ok', response };
}

/** The URL and headers this provider wants, per its authentication style. */
function requestFor(
  provider: ModelProvider,
  target: string,
  secret: string,
  baseUrl?: string | null,
): { url: string; headers: Record<string, string> } {
  const catalogue = provider.catalogue;

  if (!catalogue) {
    throw new Error('This provider has no catalogue endpoint.');
  }

  const base = baseUrl?.trim()
    ? target.replace(/^https?:\/\/[^/]+/, baseUrl.trim().replace(/\/+$/, ''))
    : target;

  const headers: Record<string, string> = { ...(catalogue.headers ?? {}) };

  if (catalogue.auth === 'bearer') {
    headers.Authorization = `Bearer ${secret}`;
    return { url: base, headers };
  }

  if (catalogue.auth === 'header') {
    headers[catalogue.authName ?? 'x-api-key'] = secret;
    return { url: base, headers };
  }

  // Google wants the key in the query string. Nothing that logs a URL may log
  // this one.
  const url = new URL(base);
  url.searchParams.set(catalogue.authName ?? 'key', secret);

  return { url: url.toString(), headers };
}

/**
 * The models out of whatever shape the provider replied with.
 *
 * Three shapes cover every provider in the table: OpenAI's `{data: [{id}]}`,
 * which most copy; Anthropic's `{data: [{id, display_name}]}`; and Google's
 * `{models: [{name: "models/gemini-…"}]}`. Anything else is read as far as it
 * can be rather than rejected — a provider that adds a field should not break
 * a settings page.
 */
export function parseModels(body: unknown): CatalogueModel[] {
  const record = body as { data?: unknown; models?: unknown } | null;
  const rows = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.models)
      ? record.models
      : [];

  const models: CatalogueModel[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }

    const entry = row as {
      id?: unknown;
      name?: unknown;
      display_name?: unknown;
    };

    // Google names a model `models/gemini-2.5-pro`; the id Pi wants is the
    // part after the prefix.
    const raw =
      typeof entry.id === 'string'
        ? entry.id
        : typeof entry.name === 'string'
          ? entry.name.replace(/^models\//, '')
          : null;

    if (!raw) {
      continue;
    }

    models.push({
      id: raw,
      label: typeof entry.display_name === 'string' ? entry.display_name : raw,
    });
  }

  // Sorted so the list is stable between renders and between providers, and
  // deduplicated because OpenRouter lists some ids under more than one route.
  return [...new Map(models.map((model) => [model.id, model])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}
