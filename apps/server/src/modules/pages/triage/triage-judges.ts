import { Injectable } from '@nestjs/common';
import { PageEntryRelationType } from '@prisma/client';
import {
  type AcceptInput,
  readAccept,
  readPair,
  SAME_MODEL_TEMPERATURE,
  triageAccept,
  triagePair,
} from '@vantikhq/llm-tasks';
import { LLMRole } from '@vantikhq/types';

import {
  isLLMConfigured,
  resolveModel,
} from 'modules/ai-requests/llm-provider';
import { generateModelText } from 'modules/ai-requests/model-call';

/**
 * The model judgments triage asks for, and nothing else.
 *
 * Two questions only a model can answer: how two similar entries relate, and
 * whether an entry that passed every check in code should be accepted. Each
 * is asked twice, independently, and the answers must agree: one model's
 * opinion of text is not a signal to act on, and a model asked about its own
 * claim is the least reliable judge there is. The two judgments are the fast
 * and smart roles, or, when a deployment serves both roles with one model,
 * that model twice at a temperature where its answers can differ.
 *
 * Entries are agent-written text, handed to the judges as data to assess and
 * never as instructions. An answer that cannot be read is the cautious one:
 * DISTINCT for a pair, a refusal to accept for an entry.
 */

/** One completion: which model answered, and what it said. */
export type Complete = (
  role: LLMRole,
  system: string,
  prompt: string,
  temperature: number,
) => Promise<{ text: string; model: string }>;

const complete: Complete = (role, system, prompt, temperature) =>
  generateModelText({
    purpose:
      system === triagePair.system ? triagePair.purpose : triageAccept.purpose,
    role,
    system,
    prompt,
    temperature,
  });

/** An entry as the judges see it. */
export type JudgedEntry = AcceptInput;

/** One judgment of how a newer entry relates to an existing one. */
export interface PairJudgment {
  type: PageEntryRelationType;
  reason: string | null;
  model: string | null;
  /** What the model answered, as it came back. */
  raw: string | null;
  /** False when there was no answer that could be read. */
  readable: boolean;
}

/** One judgment of whether an entry should be accepted. */
export interface AcceptJudgment {
  accept: boolean;
  reason: string | null;
  model: string | null;
  raw: string | null;
  readable: boolean;
}

export { SAME_MODEL_TEMPERATURE };

const RELATIONS: Record<string, PageEntryRelationType> = {
  duplicate: PageEntryRelationType.DUPLICATE,
  refines: PageEntryRelationType.REFINES,
  supersedes: PageEntryRelationType.SUPERSEDES,
  contradicts: PageEntryRelationType.CONTRADICTS,
  distinct: PageEntryRelationType.DISTINCT,
};

@Injectable()
export default class TriageJudges {
  private run: Complete = complete;
  private configured: () => boolean = isLLMConfigured;
  private modelOf: (role: LLMRole) => string = (role) =>
    resolveModel(role).modelId;

  /** Judges over a given completion, for tests: no model is ever called. */
  static using(
    run: Complete,
    options: {
      configured?: () => boolean;
      modelOf?: (role: LLMRole) => string;
    } = {},
  ): TriageJudges {
    return Object.assign(new TriageJudges(), {
      run,
      configured: options.configured ?? (() => true),
      modelOf: options.modelOf ?? ((role: LLMRole) => `${role}-model`),
    });
  }

  /** Whether any judgment can be asked for at all. */
  available(): boolean {
    return this.configured();
  }

  /** Two independent judgments of how `newer` relates to `existing`. */
  async classify(
    newer: string,
    existing: string,
  ): Promise<[PairJudgment, PairJudgment]> {
    const prompt = triagePair.prompt({ newer, existing });

    const [first, second] = await Promise.all(
      this.judges().map((judge) =>
        this.ask(judge, triagePair.system, prompt).then(parseRelation),
      ),
    );

    return [first, second];
  }

  /** Two independent judgments of whether the entry should be accepted. */
  async accept(entry: JudgedEntry): Promise<[AcceptJudgment, AcceptJudgment]> {
    const prompt = triageAccept.prompt(entry);

    const [first, second] = await Promise.all(
      this.judges().map((judge) =>
        this.ask(judge, triageAccept.system, prompt).then(parseAccept),
      ),
    );

    return [first, second];
  }

  /**
   * The two judgments to ask: two roles on two models, or one model twice at
   * a temperature where its answers can differ. Asking one model twice at
   * temperature 0 would be one judgment counted twice.
   */
  private judges(): Array<{ role: LLMRole; temperature: number }> {
    let same = false;

    try {
      same = this.modelOf('fast') === this.modelOf('smart');
    } catch {
      same = false;
    }

    return same
      ? [
          { role: 'smart', temperature: SAME_MODEL_TEMPERATURE },
          { role: 'smart', temperature: SAME_MODEL_TEMPERATURE },
        ]
      : [
          { role: 'fast', temperature: 0 },
          { role: 'smart', temperature: 0 },
        ];
  }

  private async ask(
    judge: { role: LLMRole; temperature: number },
    system: string,
    prompt: string,
  ): Promise<{ text: string | null; model: string | null; error?: string }> {
    try {
      const { text, model } = await this.run(
        judge.role,
        system,
        prompt,
        judge.temperature,
      );

      return { text, model };
    } catch (error) {
      return {
        text: null,
        model: null,
        error: (error as Error)?.message ?? String(error),
      };
    }
  }
}

/** A pair's relation as a judge answered it, or DISTINCT if it did not. */
export function parseRelation(answer: {
  text: string | null;
  model: string | null;
  error?: string;
}): PairJudgment {
  const parsed = readPair(answer.text);

  if (!parsed) {
    return {
      type: PageEntryRelationType.DISTINCT,
      reason: answer.error
        ? `the judge could not be asked: ${answer.error}`
        : 'the judge gave no answer that could be read',
      model: answer.model,
      raw: answer.text,
      readable: false,
    };
  }

  return {
    type: RELATIONS[parsed.relation],
    reason: parsed.reason,
    model: answer.model,
    raw: answer.text,
    readable: true,
  };
}

/** Whether a judge accepted the entry; an unreadable answer does not. */
export function parseAccept(answer: {
  text: string | null;
  model: string | null;
  error?: string;
}): AcceptJudgment {
  const parsed = readAccept(answer.text);

  if (!parsed) {
    return {
      accept: false,
      reason: answer.error
        ? `the judge could not be asked: ${answer.error}`
        : 'the judge gave no answer that could be read',
      model: answer.model,
      raw: answer.text,
      readable: false,
    };
  }

  return {
    accept: parsed.accept,
    reason: parsed.reason,
    model: answer.model,
    raw: answer.text,
    readable: true,
  };
}
