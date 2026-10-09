import {
  modelsChanged,
  parseDefaultFromRoles,
  parseDefaultFromYaml,
  parseOmpModels,
  thinkingLevelsOf,
} from './models';

describe('parseOmpModels', () => {
  const listing = JSON.stringify({
    models: [
      {
        provider: 'openai-codex',
        kind: 'chat',
        id: 'gpt-6.1-sol',
        selector: 'openai-codex/gpt-6.1-sol',
        name: 'GPT 6.1 Sol',
        reasoning: true,
        thinking: ['low', 'medium', 'high', 'bogus'],
      },
      {
        provider: 'apple',
        kind: 'chat',
        id: 'on-device',
        reasoning: false,
        thinking: null,
      },
      { provider: 'x', kind: 'embedding', id: 'emb', name: 'E' },
      { provider: 'x', kind: 'chat' },
    ],
  });

  it('keeps chat models and maps thinking to the levels omp takes', () => {
    expect(parseOmpModels(listing)).toEqual([
      {
        provider: 'openai-codex',
        id: 'gpt-6.1-sol',
        name: 'GPT 6.1 Sol',
        reasoning: true,
        thinkingLevels: ['low', 'medium', 'high'],
      },
      {
        provider: 'apple',
        id: 'on-device',
        name: 'on-device',
        reasoning: false,
        thinkingLevels: null,
      },
    ]);
  });

  it('treats a shape it does not know as unknown levels', () => {
    expect(thinkingLevelsOf({ levels: ['low'] })).toBeNull();
    expect(thinkingLevelsOf([])).toBeNull();
  });

  it('returns nothing for output without a models array', () => {
    expect(parseOmpModels('{}')).toEqual([]);
  });
});

describe('the default model', () => {
  it('reads modelRoles from omp config get', () => {
    expect(
      parseDefaultFromRoles('{"default":"openai-codex/gpt-6.1-sol"}'),
    ).toBe('openai-codex/gpt-6.1-sol');
    expect(parseDefaultFromRoles('not json')).toBeNull();
    expect(parseDefaultFromRoles('{}')).toBeNull();
  });

  it('reads modelRoles.default from config.yml', () => {
    const yml =
      'other: 1\nmodelRoles:\n  smol: a/b\n  default: openai-codex/gpt-6.1-sol # x\nsymbolPreset: ascii\n';
    expect(parseDefaultFromYaml(yml)).toBe('openai-codex/gpt-6.1-sol');
    expect(
      parseDefaultFromYaml('modelRoles:\n  smol: a/b\nnext: 1\n'),
    ).toBeNull();
    expect(parseDefaultFromYaml('a: 1\n')).toBeNull();
  });
});

describe('modelsChanged', () => {
  const base = { models: [], defaultModel: 'a/b' };

  it('is true for the first discovery', () => {
    expect(modelsChanged(undefined, base)).toBe(true);
  });

  it('is false for the same list and default, true for a difference', () => {
    expect(modelsChanged(base, { ...base })).toBe(false);
    expect(modelsChanged(base, { ...base, defaultModel: 'c/d' })).toBe(true);
    expect(
      modelsChanged(base, {
        ...base,
        models: [
          {
            provider: 'a',
            id: 'b',
            name: 'b',
            reasoning: false,
            thinkingLevels: null,
          },
        ],
      }),
    ).toBe(true);
  });
});
