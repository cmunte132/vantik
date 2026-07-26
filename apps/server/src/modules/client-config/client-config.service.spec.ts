import { ClientConfigService } from './client-config.service';

describe('ClientConfigService', () => {
  const env = process.env;
  const service = new ClientConfigService();

  const withLLM = {
    LLM_BASE_URL: 'https://example.test/v1',
    LLM_API_KEY: 'key',
    LLM_MODEL_FAST: 'fast-model',
    LLM_MODEL_SMART: 'smart-model',
  };

  afterAll(() => {
    process.env = env;
  });

  // The browser hides its AI affordances on this flag, so an install with no
  // endpoint shows no AI at all rather than buttons that fail on press.
  it('reports AI as available when an endpoint is configured', () => {
    process.env = { ...env, ...withLLM };

    expect(service.getClientConfig().aiEnabled).toBe(true);
  });

  it('reports AI as unavailable when it is not', () => {
    process.env = { ...env };
    for (const key of Object.keys(withLLM)) {
      delete process.env[key];
    }

    expect(service.getClientConfig().aiEnabled).toBe(false);
  });

  // Served unauthenticated to every browser that loads the page.
  it('says whether an endpoint exists without disclosing it', () => {
    process.env = { ...env, ...withLLM };

    const serialised = JSON.stringify(service.getClientConfig());

    expect(serialised).not.toContain('example.test');
    expect(serialised).not.toContain('key');
    expect(serialised).not.toContain('fast-model');
  });
});
