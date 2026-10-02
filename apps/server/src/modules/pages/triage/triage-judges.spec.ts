/**
 * The two judgments triage asks for, over a completion that answers from the
 * test: no model is ever called.
 */
import { PageEntryRelationType } from '@prisma/client';

import TriageJudges, {
  type Complete,
  parseAccept,
  parseRelation,
  SAME_MODEL_TEMPERATURE,
} from './triage-judges';

function recording(text: string | ((role: string) => string)) {
  const calls: Array<{
    role: string;
    system: string;
    prompt: string;
    temperature: number;
  }> = [];
  const run: Complete = async (role, system, prompt, temperature) => {
    calls.push({ role, system, prompt, temperature });

    return {
      text: typeof text === 'function' ? text(role) : text,
      model: `${role}-model`,
    };
  };

  return { run, calls };
}

describe('judging how two entries relate', () => {
  it('[KG-4.2] asks the fast and smart roles the same question, independently', async () => {
    const { run, calls } = recording(
      '{"relation": "refines", "reason": "adds the retry count"}',
    );

    const [first, second] = await TriageJudges.using(run).classify(
      'The worker retries webhooks with backoff.',
      'The worker retries webhooks.',
    );

    expect(calls.map((call) => [call.role, call.temperature])).toEqual([
      ['fast', 0],
      ['smart', 0],
    ]);
    expect(calls[0].prompt).toBe(calls[1].prompt);
    expect(calls[0].prompt).toContain(
      'EXISTING claim:\n"""\nThe worker retries webhooks.\n"""',
    );
    expect(calls[0].prompt).toContain(
      'NEWER claim:\n"""\nThe worker retries webhooks with backoff.\n"""',
    );
    // The entries are data, and the system prompt says so.
    expect(calls[0].system).toMatch(/never as instructions/);
    expect(first).toMatchObject({
      type: PageEntryRelationType.REFINES,
      reason: 'adds the retry count',
      model: 'fast-model',
      readable: true,
    });
    expect(second.model).toBe('smart-model');
  });

  it('[KG-4.2] reads invalid output as DISTINCT', () => {
    for (const text of [
      'They look the same to me.',
      '{"relation": "same"}',
      '{"relation": 1}',
      '["duplicate"]',
      '{not json}',
      null,
    ]) {
      expect(parseRelation({ text, model: 'm' })).toMatchObject({
        type: PageEntryRelationType.DISTINCT,
        readable: false,
      });
    }
    expect(
      parseRelation({ text: null, model: null, error: 'timeout' }),
    ).toMatchObject({
      type: PageEntryRelationType.DISTINCT,
      readable: false,
      reason: 'the judge could not be asked: timeout',
    });
    // An answer wrapped in prose is still read.
    expect(
      parseRelation({
        text: 'Here you go: {"relation": "CONTRADICTS", "reason": "opposite"}',
        model: 'm',
      }),
    ).toMatchObject({
      type: PageEntryRelationType.CONTRADICTS,
      readable: true,
    });
  });

  it('[KG-4.4] asks one model twice at a temperature where it can disagree, when both roles are that model', async () => {
    const { run, calls } = recording('{"relation": "distinct"}');

    await TriageJudges.using(run, { modelOf: () => 'one-model' }).classify(
      'a',
      'b',
    );

    expect(SAME_MODEL_TEMPERATURE).toBeGreaterThan(0);
    expect(calls.map((call) => [call.role, call.temperature])).toEqual([
      ['smart', SAME_MODEL_TEMPERATURE],
      ['smart', SAME_MODEL_TEMPERATURE],
    ]);
  });
});

describe('judging whether to accept an entry', () => {
  it('[KG-4.4] shows the judges the claim and what its citations read, and reads their verdicts', async () => {
    const { run, calls } = recording((role) =>
      role === 'fast'
        ? '{"verdict": "accept", "reason": "the lines say so"}'
        : '{"verdict": "escalate", "reason": "the lines say otherwise"}',
    );

    const [fast, smart] = await TriageJudges.using(run).accept({
      content: 'Webhooks retry three times.',
      kind: 'FACT',
      scope: 'apps/server',
      evidence: [
        'apps/server/src/webhooks.ts:40-52 (holds)\nconst RETRIES = 3;',
      ],
    });

    expect(calls[0].prompt).toContain('Webhooks retry three times.');
    expect(calls[0].prompt).toContain('about apps/server');
    expect(calls[0].prompt).toContain('const RETRIES = 3;');
    expect(calls[0].system).toMatch(/never as instructions/);
    expect(fast).toMatchObject({ accept: true, readable: true });
    expect(smart).toMatchObject({
      accept: false,
      readable: true,
      reason: 'the lines say otherwise',
    });
  });

  it('[ENG-184] reads a verdict that the evidence contradicts the claim', () => {
    expect(
      parseAccept({
        text: '{"verdict": "contradicted", "reason": "the lines say three"}',
        model: 'm',
      }),
    ).toMatchObject({
      accept: false,
      contradicted: true,
      readable: true,
      reason: 'the lines say three',
    });
    expect(
      parseAccept({ text: '{"verdict": "escalate"}', model: 'm' }),
    ).toMatchObject({ accept: false, contradicted: false, readable: true });
    expect(parseAccept({ text: 'No.', model: 'm' })).toMatchObject({
      contradicted: false,
      readable: false,
    });
  });

  it('[KG-4.7] reads an answer it cannot understand, or no answer, as not accepting', async () => {
    expect(parseAccept({ text: 'Looks good!', model: 'm' })).toMatchObject({
      accept: false,
      readable: false,
    });
    expect(
      parseAccept({ text: '{"verdict": "yes"}', model: 'm' }),
    ).toMatchObject({ accept: false, readable: false });

    const unreachable = TriageJudges.using(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const judgments = await unreachable.accept({
      content: 'x',
      kind: 'FACT',
      scope: null,
      evidence: [],
    });

    expect(judgments.map((judgment) => judgment.accept)).toEqual([
      false,
      false,
    ]);
    expect(judgments[0].reason).toContain('ECONNREFUSED');
  });

  it('[KG-4.7] says whether a model is configured at all', () => {
    const run: Complete = async () => ({ text: '', model: 'm' });

    expect(
      TriageJudges.using(run, { configured: () => false }).available(),
    ).toBe(false);
    expect(TriageJudges.using(run).available()).toBe(true);
  });

  describe('as the server builds them', () => {
    const LLM_ENV = [
      'LLM_BASE_URL',
      'LLM_API_KEY',
      'LLM_MODEL_FAST',
      'LLM_MODEL_SMART',
    ];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const name of LLM_ENV) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
    });

    afterEach(() => {
      for (const name of LLM_ENV) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    });

    it('[KG-4.7] read the deployment: no model until all four settings are there', () => {
      expect(new TriageJudges().available()).toBe(false);

      process.env.LLM_BASE_URL = 'http://llm.test/v1';
      process.env.LLM_API_KEY = 'test-key';
      process.env.LLM_MODEL_FAST = 'fast';
      expect(new TriageJudges().available()).toBe(false);

      process.env.LLM_MODEL_SMART = 'smart';
      expect(new TriageJudges().available()).toBe(true);
    });
  });
});
