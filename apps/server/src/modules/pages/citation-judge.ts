import { Injectable } from '@nestjs/common';
import {
  citationJudge,
  type CitationJudgeInput,
  readCitationVerdict,
} from '@vantikhq/llm-tasks';
import { LLMTier, PageEntryCitationJudgmentEnum } from '@vantikhq/types';

import {
  isLLMConfigured,
  resolveModel,
} from 'modules/ai-requests/llm-provider';
import { generateModelText } from 'modules/ai-requests/model-call';

/**
 * Whether code that changed under a citation still supports the claim.
 *
 * Only a CHANGED citation reaches this. Held, moved and missing are decided by
 * comparing text; a model is asked only the question text cannot answer, and
 * its answer is recorded beside the check rather than replacing it.
 *
 * The judge is not the writer. A model asked whether its own claim holds is
 * the least reliable judge available, so the decisions tier judges unless its
 * model wrote the claim, and then the default tier does. The claim itself is agent-written text,
 * handed to the judge as data to assess and never as instructions.
 */

export interface JudgeRequest extends CitationJudgeInput {
  /** The model that wrote the claim, when a run recorded it. */
  writerModel?: string | null;
}

export interface JudgeResult {
  verdict: PageEntryCitationJudgmentEnum;
  /** The current lines the judge relied on, e.g. "44-51". */
  lines: string | null;
  reason: string | null;
  /** The model that judged; null when none did. */
  model: string | null;
}

/** One completion: which model answered, and what it said. */
export type Complete = (
  tier: LLMTier,
  system: string,
  prompt: string,
) => Promise<{ text: string; model: string }>;

const complete: Complete = (tier, system, prompt) =>
  generateModelText({
    purpose: citationJudge.purpose,
    tier,
    system,
    prompt,
    temperature: citationJudge.temperature,
  });

@Injectable()
export default class CitationJudge {
  private run: Complete = complete;
  private configured: () => boolean = isLLMConfigured;

  /** A judge over a given completion, for tests: no model is ever called. */
  static using(run: Complete, configured = () => true): CitationJudge {
    return Object.assign(new CitationJudge(), { run, configured });
  }

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    if (!this.configured()) {
      return {
        verdict: PageEntryCitationJudgmentEnum.UNCLEAR,
        lines: null,
        reason: 'no language model is configured to judge a changed citation',
        model: null,
      };
    }

    try {
      const { text, model } = await this.run(
        judgeTier(request.writerModel),
        citationJudge.system,
        citationJudge.prompt(request),
      );

      return { ...parseVerdict(text, request.region), model };
    } catch (error) {
      return {
        verdict: PageEntryCitationJudgmentEnum.UNCLEAR,
        lines: null,
        reason: `the judge could not be asked: ${(error as Error)?.message ?? error}`,
        model: null,
      };
    }
  }
}

/**
 * The tier that judges a claim: the decisions tier, unless its model is the
 * one that wrote the claim. Then the default tier judges, which is the same
 * model again only when the deployment runs one model for both.
 */
export function judgeTier(writerModel?: string | null): LLMTier {
  if (!writerModel) {
    return citationJudge.tier;
  }

  try {
    return resolveModel(citationJudge.tier).modelId === writerModel
      ? 'default'
      : citationJudge.tier;
  } catch {
    return citationJudge.tier;
  }
}

const VERDICTS: Record<string, PageEntryCitationJudgmentEnum> = {
  holds: PageEntryCitationJudgmentEnum.HOLDS,
  contradicted: PageEntryCitationJudgmentEnum.CONTRADICTED,
  unclear: PageEntryCitationJudgmentEnum.UNCLEAR,
};

/**
 * The judge's answer, or unclear if it gave none that can be read. Lines
 * outside the region it was shown are dropped: it cannot have relied on code
 * it never saw.
 */
export function parseVerdict(
  text: string,
  region: { startLine: number; lines: string[] },
): Omit<JudgeResult, 'model'> {
  const answer = readCitationVerdict(text, region);

  return answer
    ? { ...answer, verdict: VERDICTS[answer.verdict] }
    : {
        verdict: PageEntryCitationJudgmentEnum.UNCLEAR,
        lines: null,
        reason: 'the judge gave no answer that could be read',
      };
}
