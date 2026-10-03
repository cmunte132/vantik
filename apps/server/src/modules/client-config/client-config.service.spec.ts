import { ClientConfigService } from './client-config.service';

describe('ClientConfigService', () => {
  const env = process.env;
  const service = new ClientConfigService();

  const withLLM = {
    LLM_BASE_URL: 'https://example.test/v1',
    LLM_API_KEY: 'key',
    LLM_MODEL: 'default-model',
    LLM_MODEL_DECISIONS: 'decisions-model',
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
    expect(serialised).not.toContain('default-model');
    expect(serialised).not.toContain('decisions-model');
  });

  // The browser starts its SDK on this flag, and the flag must not disclose
  // the backend or the credentials the server sends to it.
  it('reports telemetry as on when an OTLP endpoint is set, and hides it', () => {
    process.env = {
      ...env,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.test',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Basic%20c2VjcmV0',
    };

    const config = service.getClientConfig();
    const serialised = JSON.stringify(config);

    expect(config.telemetryEnabled).toBe(true);
    expect(serialised).not.toContain('example.test');
    expect(serialised).not.toContain('c2VjcmV0');
  });

  it('reports telemetry as off when no endpoint is set', () => {
    process.env = { ...env };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;

    expect(service.getClientConfig().telemetryEnabled).toBe(false);
  });
});
