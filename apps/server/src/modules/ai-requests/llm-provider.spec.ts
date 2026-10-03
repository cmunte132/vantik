import { coerceTier, isLLMConfigured, resolveModel } from './llm-provider';

describe('coerceTier', () => {
  it.each(['default', 'decisions'] as const)('passes %s through', (tier) => {
    expect(coerceTier(tier)).toBe(tier);
  });

  // The AI endpoint is public API, so a server can always be asked for a role
  // or a model id that was current whenever its caller was written. Those
  // callers asked for text, not for a decision, so they all get the default
  // tier. Nothing here is a temporary shim.
  it.each([
    'fast',
    'smart',
    'gpt-3.5-turbo',
    'gpt-4o',
    'claude-3-opus-20240229',
    'llama3',
    'Decisions',
    'some-model-we-have-never-seen',
  ])('takes the default tier for the legacy value %s', (legacy) => {
    expect(coerceTier(legacy)).toBe('default');
  });

  it.each([undefined, null, '', '   '])(
    'falls back to default when given %p',
    (empty) => {
      expect(coerceTier(empty)).toBe('default');
    },
  );
});

describe('isLLMConfigured', () => {
  const env = process.env;
  const complete = {
    LLM_BASE_URL: 'https://example.test/v1',
    LLM_API_KEY: 'key',
    LLM_MODEL: 'default-model',
  };

  afterAll(() => {
    process.env = env;
  });

  it('is true once all three variables are set', () => {
    process.env = { ...env, ...complete };
    delete process.env.LLM_MODEL_DECISIONS;

    expect(isLLMConfigured()).toBe(true);
  });

  // This is what the browser reads to decide whether to show the AI
  // affordances at all, so a half-configured install has to read as off — the
  // alternative is buttons that fail on press.
  it.each(Object.keys(complete))('is false without %s', (missing) => {
    process.env = { ...env, ...complete };
    delete process.env[missing];

    expect(isLLMConfigured()).toBe(false);
  });

  it('treats a blank value as unset', () => {
    process.env = { ...env, ...complete, LLM_API_KEY: '   ' };

    expect(isLLMConfigured()).toBe(false);
  });
});

describe('resolveModel', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.LLM_MODEL_DECISIONS;
  });

  afterAll(() => {
    process.env = env;
  });

  it('resolves each tier through its own variable', () => {
    process.env.LLM_MODEL = 'openai/gpt-oss-120b';
    process.env.LLM_MODEL_DECISIONS = 'google/gemini-3.8-flash';

    expect(resolveModel('default')).toEqual({
      tier: 'default',
      modelId: 'openai/gpt-oss-120b',
    });
    expect(resolveModel('decisions')).toEqual({
      tier: 'decisions',
      modelId: 'google/gemini-3.8-flash',
    });
  });

  it('serves the decisions with LLM_MODEL when LLM_MODEL_DECISIONS is unset', () => {
    process.env.LLM_MODEL = 'openai/gpt-oss-120b';
    process.env.LLM_MODEL_DECISIONS = '  ';

    expect(resolveModel('decisions')).toEqual({
      tier: 'decisions',
      modelId: 'openai/gpt-oss-120b',
    });
  });

  // The switch this replaced fell through to a local model whenever it could
  // not resolve one, so a half-configured install kept answering with something
  // nobody had chosen. A missing variable has to say which one it is.
  it('throws naming the unset variable rather than falling back', () => {
    delete process.env.LLM_MODEL;

    expect(() => resolveModel('decisions')).toThrow('LLM_MODEL');
  });
});
