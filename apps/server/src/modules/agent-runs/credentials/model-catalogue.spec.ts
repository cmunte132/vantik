import { MODEL_PROVIDERS, providerById } from '@vantikhq/types';

import { fetchCatalogue, parseModels } from './model-catalogue';

/**
 * Asking a provider what a key can reach.
 *
 * This is what turns pasting a key from an act of faith into an answer. The
 * three outcomes carry the weight: a refused key is the person's mistake and
 * must not be stored, an unreachable provider is nobody's mistake and must not
 * be reported as a bad key.
 */
describe('the provider table', () => {
  it('gives every provider the environment variable its own SDK reads', () => {
    // The reason this table exists. Pi has no generic key variable, so a key
    // stored under a name of our choosing authenticates nothing — which is
    // exactly what used to happen when every provider shared `LLM_API_KEY`.
    const names = MODEL_PROVIDERS.map((provider) => provider.envVar);

    expect(names).not.toContain('LLM_API_KEY');
    expect(new Set(names).size).toBe(names.length);
    expect(providerById('anthropic')?.envVar).toBe('ANTHROPIC_API_KEY');
    expect(providerById('openai')?.envVar).toBe('OPENAI_API_KEY');
    // Not GOOGLE_API_KEY, which is the neighbouring name Pi does not read.
    expect(providerById('google')?.envVar).toBe('GEMINI_API_KEY');
  });

  it('knows a host for every provider that has a fixed one', () => {
    for (const provider of MODEL_PROVIDERS) {
      // Without a host the sandbox denies the model call: egress is a
      // allowlist. Azure is the one exception, and it requires a base URL.
      expect(Boolean(provider.host) || provider.baseUrl?.required).toBe(true);
    }
  });
});

describe('reading a provider model list', () => {
  it('reads the OpenAI shape most providers copy', () => {
    expect(parseModels({ data: [{ id: 'gpt-5' }, { id: 'gpt-4.1' }] })).toEqual([
      { id: 'gpt-4.1', label: 'gpt-4.1' },
      { id: 'gpt-5', label: 'gpt-5' },
    ]);
  });

  it('prefers a display name when the provider sends one', () => {
    expect(
      parseModels({
        data: [{ id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' }],
      }),
    ).toEqual([{ id: 'claude-opus-4-5', label: 'Claude Opus 4.5' }]);
  });

  it('strips the prefix Google puts on a model name', () => {
    // Google answers `models/gemini-2.5-pro`; the id Pi wants is the tail.
    expect(parseModels({ models: [{ name: 'models/gemini-2.5-pro' }] })).toEqual(
      [{ id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' }],
    );
  });

  it('drops duplicates and anything with no id', () => {
    expect(
      parseModels({ data: [{ id: 'a' }, { id: 'a' }, {}, 'nonsense', null] }),
    ).toEqual([{ id: 'a', label: 'a' }]);
  });

  it('reads a shape it does not recognise as empty rather than throwing', () => {
    // A settings page must not break because a provider added a field.
    expect(parseModels({ unexpected: true })).toEqual([]);
    expect(parseModels(null)).toEqual([]);
  });
});

describe('checking a key against its provider', () => {
  const anthropic = providerById('anthropic')!;

  function reply(status: number, body: unknown = {}): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  it('reports what the key reaches when the provider answers', async () => {
    const result = await fetchCatalogue(
      anthropic,
      'sk-ant-real',
      null,
      reply(200, { data: [{ id: 'claude-opus-4-5' }] }),
    );

    expect(result).toEqual({
      outcome: 'ok',
      models: [{ id: 'claude-opus-4-5', label: 'claude-opus-4-5' }],
    });
  });

  it('rejects a key the provider refuses', async () => {
    for (const status of [401, 403]) {
      await expect(
        fetchCatalogue(anthropic, 'sk-ant-wrong', null, reply(status)),
      ).resolves.toMatchObject({ outcome: 'rejected' });
    }
  });

  it('does not call an unreachable provider a bad key', async () => {
    // The distinction that matters. Storing nothing because a provider was
    // down would tell somebody their correct key was wrong.
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    await expect(
      fetchCatalogue(anthropic, 'sk-ant-real', null, offline),
    ).resolves.toMatchObject({ outcome: 'unknown' });

    await expect(
      fetchCatalogue(anthropic, 'sk-ant-real', null, reply(500)),
    ).resolves.toMatchObject({ outcome: 'unknown' });
  });

  it('sends the key the way each provider wants it', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const record = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await fetchCatalogue(anthropic, 'sk-ant', null, record);
    // Anthropic refuses a request that does not name a version.
    expect(seen[0].headers['x-api-key']).toBe('sk-ant');
    expect(seen[0].headers['anthropic-version']).toBeDefined();

    await fetchCatalogue(providerById('openai')!, 'sk-oai', null, record);
    expect(seen[1].headers.Authorization).toBe('Bearer sk-oai');

    await fetchCatalogue(providerById('google')!, 'AIza-key', null, record);
    // Google takes it in the query string, which is why nothing here logs a
    // catalogue URL.
    expect(seen[2].url).toContain('key=AIza-key');
    expect(seen[2].headers.Authorization).toBeUndefined();
  });

  it('says so rather than failing when a provider publishes no list', async () => {
    const azure = providerById('azure-openai-responses')!;

    await expect(
      fetchCatalogue(azure, 'key', 'https://acme.openai.azure.com'),
    ).resolves.toMatchObject({ outcome: 'unknown' });
  });

  it('checks the key separately where the model list is public', async () => {
    // Found live: OpenRouter serves its catalogue to anyone and ignores the
    // key, so a wrong key returned the full list and was stored as valid.
    // Checking it means asking an endpoint that actually requires one.
    const openrouter = providerById('openrouter')!;
    const asked: string[] = [];

    const answer = (async (url: string) => {
      asked.push(url);
      return url.endsWith('/key')
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ data: [{ id: 'anything' }] }), {
            status: 200,
          });
    }) as unknown as typeof fetch;

    await expect(
      fetchCatalogue(openrouter, 'sk-or-wrong', null, answer),
    ).resolves.toMatchObject({ outcome: 'rejected' });

    // And it never got as far as the list, so a public catalogue cannot
    // overrule the verdict.
    expect(asked).toEqual(['https://openrouter.ai/api/v1/key']);
  });

  it('still lists the models when that key check passes', async () => {
    const openrouter = providerById('openrouter')!;

    const answer = (async (url: string) =>
      url.endsWith('/key')
        ? new Response('{"data":{}}', { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: 'x/y' }] }), {
            status: 200,
          })) as unknown as typeof fetch;

    await expect(
      fetchCatalogue(openrouter, 'sk-or-right', null, answer),
    ).resolves.toEqual({ outcome: 'ok', models: [{ id: 'x/y', label: 'x/y' }] });
  });

  it('treats a bad key as bad even when the provider says 400', async () => {
    // Also found live: Google answers an invalid key with 400, not 401, so it
    // read as "the provider had a problem" and the key was stored.
    await expect(
      fetchCatalogue(providerById('google')!, 'AIza-wrong', null, reply(400)),
    ).resolves.toMatchObject({ outcome: 'rejected' });

    // And a 400 from a provider that does not do this still means nothing
    // about the key.
    await expect(
      fetchCatalogue(anthropic, 'sk-ant', null, reply(400)),
    ).resolves.toMatchObject({ outcome: 'unknown' });
  });
});
