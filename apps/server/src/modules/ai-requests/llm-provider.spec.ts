import { coerceRole, isLLMConfigured, resolveModel } from './llm-provider';

describe('coerceRole', () => {
  it.each(['fast', 'smart'] as const)('passes %s through', (role) => {
    expect(coerceRole(role)).toBe(role);
  });

  // Actions deploy to trigger.dev independently of the server, so a server can
  // always be asked for a model id that was current whenever those actions were
  // last shipped. Nothing here is a temporary shim.
  it.each([
    ['gpt-3.5-turbo', 'fast'],
    ['gpt-3.5-turbo-0125', 'fast'],
    ['gpt-4o-mini', 'fast'],
    ['claude-3-haiku-20240307', 'fast'],
    ['gpt-4-turbo', 'smart'],
    ['gpt-4o', 'smart'],
    ['claude-3-opus-20240229', 'smart'],
    ['llama3', 'fast'],
  ])('maps the legacy id %s to %s', (legacy, role) => {
    expect(coerceRole(legacy)).toBe(role);
  });

  // An id we cannot place is a guess, and a guess that picks the paid model
  // bills the install for it silently. 'llama3' and 'gemma2:2b' were the local
  // fallback models, and the migration reads LLAMA3 as fast for the same
  // reason.
  it.each(['gemma2:2b', 'Fast', 'some-model-we-have-never-seen'])(
    'takes the cheap role for the unrecognised id %s',
    (unknown) => {
      expect(coerceRole(unknown)).toBe('fast');
    },
  );

  it.each([undefined, null, '', '   '])(
    'falls back to fast when given %p',
    (empty) => {
      expect(coerceRole(empty)).toBe('fast');
    },
  );
});

describe('isLLMConfigured', () => {
  const env = process.env;
  const complete = {
    LLM_BASE_URL: 'https://example.test/v1',
    LLM_API_KEY: 'key',
    LLM_MODEL_FAST: 'fast-model',
    LLM_MODEL_SMART: 'smart-model',
  };

  afterAll(() => {
    process.env = env;
  });

  it('is true once all four variables are set', () => {
    process.env = { ...env, ...complete };

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
  });

  afterAll(() => {
    process.env = env;
  });

  it('resolves each role through its own variable', () => {
    process.env.LLM_MODEL_FAST = 'openai/gpt-5-mini';
    process.env.LLM_MODEL_SMART = 'anthropic/claude-opus-4.5';

    expect(resolveModel('fast')).toEqual({
      role: 'fast',
      modelId: 'openai/gpt-5-mini',
    });
    expect(resolveModel('smart')).toEqual({
      role: 'smart',
      modelId: 'anthropic/claude-opus-4.5',
    });
  });

  // The switch this replaced fell through to a local model whenever it could
  // not resolve one, so a half-configured install kept answering with something
  // nobody had chosen. A missing variable has to say which one it is.
  it('throws naming the unset variable rather than falling back', () => {
    delete process.env.LLM_MODEL_SMART;

    expect(() => resolveModel('smart')).toThrow('LLM_MODEL_SMART');
  });
});
