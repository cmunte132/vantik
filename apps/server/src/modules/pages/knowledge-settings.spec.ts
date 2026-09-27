import {
  DEFAULT_KNOWLEDGE_SETTINGS,
  knowledgeSettings,
  MAX_KNOWLEDGE_TOKEN_BUDGET,
} from './knowledge-settings';

/**
 * The knowledge settings: a default, the deployment's variable over it, and
 * the workspace's preference over that. A setting that cannot be read falls
 * to the layer beneath rather than being guessed at.
 */
describe('the knowledge settings of a workspace', () => {
  it('[KG-3.2] [KG-3.3] holds out a tenth and hands five entries in 1500 tokens unless told otherwise', () => {
    expect(knowledgeSettings(null, {})).toEqual({
      holdoutRate: 0.1,
      contextTopK: 5,
      contextTokenBudget: 1_500,
    });
    expect(DEFAULT_KNOWLEDGE_SETTINGS).toEqual(knowledgeSettings({}, {}));
  });

  it('[KG-3.2] [KG-3.3] reads the deployment’s variables', () => {
    expect(
      knowledgeSettings(null, {
        KNOWLEDGE_HOLDOUT_RATE: '0.25',
        KNOWLEDGE_CONTEXT_TOP_K: '2',
        KNOWLEDGE_CONTEXT_TOKEN_BUDGET: '800',
      }),
    ).toEqual({ holdoutRate: 0.25, contextTopK: 2, contextTokenBudget: 800 });
    // The ends of a share are shares.
    expect(
      knowledgeSettings(null, { KNOWLEDGE_HOLDOUT_RATE: '0' }),
    ).toMatchObject({ holdoutRate: 0 });
    expect(
      knowledgeSettings(null, { KNOWLEDGE_HOLDOUT_RATE: '1' }),
    ).toMatchObject({ holdoutRate: 1 });
  });

  it('[KG-3.2] [KG-3.3] puts the workspace’s preference over the deployment’s', () => {
    const env = {
      KNOWLEDGE_HOLDOUT_RATE: '0.25',
      KNOWLEDGE_CONTEXT_TOP_K: '2',
      KNOWLEDGE_CONTEXT_TOKEN_BUDGET: '800',
    };

    expect(
      knowledgeSettings(
        {
          knowledge: {
            holdoutRate: 0,
            contextTopK: 3,
            contextTokenBudget: 600,
          },
        },
        env,
      ),
    ).toEqual({ holdoutRate: 0, contextTopK: 3, contextTokenBudget: 600 });
    // One setting stored leaves the others to the deployment.
    expect(knowledgeSettings({ knowledge: { contextTopK: 3 } }, env)).toEqual({
      holdoutRate: 0.25,
      contextTopK: 3,
      contextTokenBudget: 800,
    });
    // Other preferences are not knowledge settings.
    expect(
      knowledgeSettings({ agentRuns: { holdoutRate: 0 } }, env).holdoutRate,
    ).toBe(0.25);
  });

  it('[KG-3.2] [KG-3.3] drops a setting that cannot be read, never reading it as none or all', () => {
    const env = {
      KNOWLEDGE_HOLDOUT_RATE: '10',
      KNOWLEDGE_CONTEXT_TOP_K: '0',
      KNOWLEDGE_CONTEXT_TOKEN_BUDGET: 'lots',
    };

    expect(knowledgeSettings(null, env)).toEqual(DEFAULT_KNOWLEDGE_SETTINGS);

    for (const wrong of ['-0.1', 'half', 'NaN', 'Infinity', ' ']) {
      expect(
        knowledgeSettings(null, { KNOWLEDGE_HOLDOUT_RATE: wrong }).holdoutRate,
      ).toBe(0.1);
    }
    for (const wrong of ['2.5', '-1', 'five']) {
      expect(
        knowledgeSettings(null, { KNOWLEDGE_CONTEXT_TOP_K: wrong }).contextTopK,
      ).toBe(5);
    }

    // A stored string, a fraction of an entry or a share above one is a
    // mistake in the JSON, and the deployment's setting stands.
    expect(
      knowledgeSettings(
        {
          knowledge: {
            holdoutRate: '0',
            contextTopK: 2.5,
            contextTokenBudget: -100,
          },
        },
        { KNOWLEDGE_HOLDOUT_RATE: '0.3' },
      ),
    ).toEqual({ holdoutRate: 0.3, contextTopK: 5, contextTokenBudget: 1_500 });
    expect(
      knowledgeSettings({ knowledge: { holdoutRate: 1.5 } }, {}).holdoutRate,
    ).toBe(0.1);
    for (const preferences of [
      'on',
      [1, 2],
      { knowledge: 'on' },
      { knowledge: [0.5] },
      { knowledge: null },
    ]) {
      expect(knowledgeSettings(preferences, {})).toEqual(
        DEFAULT_KNOWLEDGE_SETTINGS,
      );
    }
  });

  it('[KG-3.2] caps the budget, so a budget cannot mean everything', () => {
    expect(
      knowledgeSettings(null, { KNOWLEDGE_CONTEXT_TOKEN_BUDGET: '1000000' })
        .contextTokenBudget,
    ).toBe(MAX_KNOWLEDGE_TOKEN_BUDGET);
    expect(
      knowledgeSettings({ knowledge: { contextTokenBudget: 1_000_000 } }, {})
        .contextTokenBudget,
    ).toBe(MAX_KNOWLEDGE_TOKEN_BUDGET);
  });
});
