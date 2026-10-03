/**
 * The judge of a changed citation: a model other than the writer's, asked
 * only whether the new code still supports the claim.
 */
import { PageEntryCitationJudgmentEnum } from '@vantikhq/types';

import CitationJudge, {
  Complete,
  judgeTier,
  parseVerdict,
} from './citation-judge';

const REGION = { startLine: 40, lines: ['a', 'b', 'c', 'd', 'e'] };

const REQUEST = {
  claim: 'Deleting a page archives its entries.',
  path: 'src/pages.ts',
  snippet: 'archive(entries)',
  region: REGION,
};

describe('the citation judge', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.LLM_MODEL = 'vendor/default-model';
    process.env.LLM_MODEL_DECISIONS = 'vendor/decisions-model';
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('[KG-2.5] answers holds, contradicted or unclear, with the lines relied on and the model that judged', async () => {
    const run = jest.fn<ReturnType<Complete>, Parameters<Complete>>(
      async () => ({
        text: '{"verdict": "contradicted", "lines": "41-43", "reason": "It now deletes them."}',
        model: 'vendor/decisions-model',
      }),
    );

    await expect(CitationJudge.using(run).judge(REQUEST)).resolves.toEqual({
      verdict: PageEntryCitationJudgmentEnum.CONTRADICTED,
      lines: '41-43',
      reason: 'It now deletes them.',
      model: 'vendor/decisions-model',
    });

    const [, system, prompt] = run.mock.calls[0];
    expect(system).toMatch(/never as\s+instructions/);
    expect(prompt).toContain(REQUEST.claim);
    expect(prompt).toContain('archive(entries)');
    expect(prompt).toContain('40: a');
    expect(prompt).toContain('44: e');
  });

  it('[KG-2.5] uses the decisions tier, and the default tier when the decisions model wrote the claim', async () => {
    const tiers: string[] = [];
    const run: Complete = async (tier) => {
      tiers.push(tier);
      return { text: '{"verdict": "holds"}', model: `model-for-${tier}` };
    };
    const judge = CitationJudge.using(run);

    await judge.judge(REQUEST);
    await judge.judge({ ...REQUEST, writerModel: 'vendor/default-model' });
    const result = await judge.judge({
      ...REQUEST,
      writerModel: 'vendor/decisions-model',
    });

    expect(tiers).toEqual(['decisions', 'decisions', 'default']);
    expect(result.model).toBe('model-for-default');
    expect(judgeTier('vendor/decisions-model')).toBe('default');
    expect(judgeTier('someone-elses-model')).toBe('decisions');
  });

  it('[KG-2.5] is unclear, having asked no model, when none is configured', async () => {
    const run = jest.fn();

    await expect(
      CitationJudge.using(run, () => false).judge(REQUEST),
    ).resolves.toEqual({
      verdict: PageEntryCitationJudgmentEnum.UNCLEAR,
      lines: null,
      reason: expect.stringContaining('no language model'),
      model: null,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('[KG-2.5] is unclear when the model fails or answers nothing readable', async () => {
    const failing = CitationJudge.using(async () => {
      throw new Error('rate limited');
    });

    await expect(failing.judge(REQUEST)).resolves.toMatchObject({
      verdict: PageEntryCitationJudgmentEnum.UNCLEAR,
      model: null,
    });

    expect(parseVerdict('I think it holds.', REGION).verdict).toBe(
      PageEntryCitationJudgmentEnum.UNCLEAR,
    );
    expect(parseVerdict('{"verdict": "probably"}', REGION).verdict).toBe(
      PageEntryCitationJudgmentEnum.UNCLEAR,
    );
  });

  it('[KG-2.5] drops lines the judge was never shown', () => {
    expect(
      parseVerdict('{"verdict": "HOLDS", "lines": "38-41"}', REGION),
    ).toMatchObject({
      verdict: PageEntryCitationJudgmentEnum.HOLDS,
      lines: null,
    });
    expect(
      parseVerdict(
        'Sure: ```json\n{"verdict": "holds", "lines": "44"}\n```',
        REGION,
      ).lines,
    ).toBe('44');
  });
});
