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
      autoTriage: 'shadow',
      similarityThreshold: 0.25,
      auditRate: 0.1,
      kappaFloor: 0.6,
      kappaMinSamples: 20,
      kappaWindowDays: 30,
      conventionMinRuns: 3,
      conventionHarmMargin: 3,
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
    ).toEqual({
      holdoutRate: 0.25,
      contextTopK: 2,
      contextTokenBudget: 800,
      autoTriage: 'shadow',
      similarityThreshold: 0.25,
      auditRate: 0.1,
      kappaFloor: 0.6,
      kappaMinSamples: 20,
      kappaWindowDays: 30,
      conventionMinRuns: 3,
      conventionHarmMargin: 3,
    });
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
    ).toEqual({
      holdoutRate: 0,
      contextTopK: 3,
      contextTokenBudget: 600,
      autoTriage: 'shadow',
      similarityThreshold: 0.25,
      auditRate: 0.1,
      kappaFloor: 0.6,
      kappaMinSamples: 20,
      kappaWindowDays: 30,
      conventionMinRuns: 3,
      conventionHarmMargin: 3,
    });
    // One setting stored leaves the others to the deployment.
    expect(knowledgeSettings({ knowledge: { contextTopK: 3 } }, env)).toEqual({
      holdoutRate: 0.25,
      contextTopK: 3,
      contextTokenBudget: 800,
      autoTriage: 'shadow',
      similarityThreshold: 0.25,
      auditRate: 0.1,
      kappaFloor: 0.6,
      kappaMinSamples: 20,
      kappaWindowDays: 30,
      conventionMinRuns: 3,
      conventionHarmMargin: 3,
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
    ).toEqual({
      holdoutRate: 0.3,
      contextTopK: 5,
      contextTokenBudget: 1_500,
      autoTriage: 'shadow',
      similarityThreshold: 0.25,
      auditRate: 0.1,
      kappaFloor: 0.6,
      kappaMinSamples: 20,
      kappaWindowDays: 30,
      conventionMinRuns: 3,
      conventionHarmMargin: 3,
    });
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

  it('[KG-4.5] starts triage in shadow mode, and reads off, shadow or on from the deployment and the workspace', () => {
    expect(knowledgeSettings(null, {}).autoTriage).toBe('shadow');
    expect(DEFAULT_KNOWLEDGE_SETTINGS.autoTriage).toBe('shadow');

    for (const mode of ['off', 'shadow', 'on'] as const) {
      expect(
        knowledgeSettings(null, { KNOWLEDGE_AUTO_TRIAGE: mode }).autoTriage,
      ).toBe(mode);
      // The workspace's choice wins over the deployment's, both ways.
      expect(
        knowledgeSettings(
          { knowledge: { autoTriage: mode } },
          { KNOWLEDGE_AUTO_TRIAGE: mode === 'on' ? 'off' : 'on' },
        ).autoTriage,
      ).toBe(mode);
    }

    // An operator's casing and spacing are forgiven; a typo is not a mode,
    // and never switches triage on.
    expect(
      knowledgeSettings(null, { KNOWLEDGE_AUTO_TRIAGE: ' ON ' }).autoTriage,
    ).toBe('on');
    for (const wrong of ['yes', 'true', '1', 'enabled', '']) {
      expect(
        knowledgeSettings(null, { KNOWLEDGE_AUTO_TRIAGE: wrong }).autoTriage,
      ).toBe('shadow');
    }
    // A stored value that is not one of the three leaves the deployment's.
    for (const wrong of ['ON', true, 1, null, { mode: 'on' }]) {
      expect(
        knowledgeSettings(
          { knowledge: { autoTriage: wrong } },
          { KNOWLEDGE_AUTO_TRIAGE: 'off' },
        ).autoTriage,
      ).toBe('off');
    }
  });

  it('[KG-4.2] reads the similarity threshold as a share, from the deployment and the workspace', () => {
    expect(knowledgeSettings(null, {}).similarityThreshold).toBe(0.25);
    expect(
      knowledgeSettings(null, { KNOWLEDGE_SIMILARITY_THRESHOLD: '0.6' })
        .similarityThreshold,
    ).toBe(0.6);
    expect(
      knowledgeSettings(
        { knowledge: { similarityThreshold: 0.4 } },
        { KNOWLEDGE_SIMILARITY_THRESHOLD: '0.6' },
      ).similarityThreshold,
    ).toBe(0.4);
    for (const wrong of ['1.5', '-0.2', 'close', ' ']) {
      expect(
        knowledgeSettings(null, { KNOWLEDGE_SIMILARITY_THRESHOLD: wrong })
          .similarityThreshold,
      ).toBe(0.25);
    }
  });

  it('[KG-5.2] [KG-5.4] audits a tenth, and backs off below 0.6 over 20 verdicts in 30 days, unless told otherwise', () => {
    expect(knowledgeSettings(null, {})).toMatchObject({
      auditRate: 0.1,
      kappaFloor: 0.6,
      kappaMinSamples: 20,
      kappaWindowDays: 30,
    });

    const env = {
      KNOWLEDGE_AUDIT_RATE: '0.5',
      KNOWLEDGE_KAPPA_FLOOR: '0.7',
      KNOWLEDGE_KAPPA_MIN_SAMPLES: '40',
      KNOWLEDGE_KAPPA_WINDOW_DAYS: '14',
    };

    expect(knowledgeSettings(null, env)).toMatchObject({
      auditRate: 0.5,
      kappaFloor: 0.7,
      kappaMinSamples: 40,
      kappaWindowDays: 14,
    });
    // The workspace's own over the deployment's.
    expect(
      knowledgeSettings(
        {
          knowledge: {
            auditRate: 1,
            kappaFloor: 0,
            kappaMinSamples: 5,
            kappaWindowDays: 7,
          },
        },
        env,
      ),
    ).toMatchObject({
      auditRate: 1,
      kappaFloor: 0,
      kappaMinSamples: 5,
      kappaWindowDays: 7,
    });
    // What cannot be read falls to the layer beneath.
    expect(
      knowledgeSettings(
        {
          knowledge: {
            auditRate: 2,
            kappaFloor: '0.9',
            kappaMinSamples: 0,
            kappaWindowDays: 1.5,
          },
        },
        {
          KNOWLEDGE_AUDIT_RATE: 'some',
          KNOWLEDGE_KAPPA_FLOOR: '-0.2',
          KNOWLEDGE_KAPPA_MIN_SAMPLES: 'many',
          KNOWLEDGE_KAPPA_WINDOW_DAYS: '-3',
        },
      ),
    ).toMatchObject({
      auditRate: 0.1,
      kappaFloor: 0.6,
      kappaMinSamples: 20,
      kappaWindowDays: 30,
    });
  });

  it('[KG-6.3] proposes a convention after 3 runs, and switches one off 3 outcomes behind, unless told otherwise', () => {
    expect(knowledgeSettings(null, {})).toMatchObject({
      conventionMinRuns: 3,
      conventionHarmMargin: 3,
    });

    const env = {
      KNOWLEDGE_CONVENTION_MIN_RUNS: '5',
      KNOWLEDGE_CONVENTION_HARM_MARGIN: '4',
    };

    expect(knowledgeSettings(null, env)).toMatchObject({
      conventionMinRuns: 5,
      conventionHarmMargin: 4,
    });
    // The workspace's own over the deployment's.
    expect(
      knowledgeSettings(
        { knowledge: { conventionMinRuns: 2, conventionHarmMargin: 6 } },
        env,
      ),
    ).toMatchObject({ conventionMinRuns: 2, conventionHarmMargin: 6 });
    // A count that cannot be read falls to the layer beneath: never none,
    // which would propose every finding or switch off every convention.
    expect(
      knowledgeSettings(
        { knowledge: { conventionMinRuns: 0, conventionHarmMargin: 2.5 } },
        {
          KNOWLEDGE_CONVENTION_MIN_RUNS: 'few',
          KNOWLEDGE_CONVENTION_HARM_MARGIN: '-1',
        },
      ),
    ).toMatchObject({ conventionMinRuns: 3, conventionHarmMargin: 3 });
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
