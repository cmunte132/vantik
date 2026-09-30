import { Injectable } from '@nestjs/common';
import {
  pageRefresh,
  type WriterEntry,
  type WriterInput,
} from '@vantikhq/llm-tasks';
import { type LLMRole } from '@vantikhq/types';

import { isLLMConfigured } from 'modules/ai-requests/llm-provider';
import { generateModelText } from 'modules/ai-requests/model-call';

/**
 * The model call a refresh of a generated page makes, and nothing else.
 *
 * The model is shown the page's question, its sections and the entries read
 * for it, and answers with edits to the sections by id. It never returns a
 * page: what it answers is applied in code (`sections.ts`), so a section it
 * does not name is kept exactly as it was. The sections and the entries were
 * written by people and other programs, and are handed over as data to work
 * from, never as instructions.
 */

/** One completion: which model answered, and what it said. */
export type WriterComplete = (
  role: LLMRole,
  system: string,
  prompt: string,
) => Promise<{ text: string; model: string }>;

const complete: WriterComplete = (role, system, prompt) =>
  generateModelText({
    purpose: pageRefresh.purpose,
    role,
    system,
    prompt,
    temperature: pageRefresh.temperature,
  });

export type { WriterEntry, WriterInput };

export interface WriterAnswer {
  /** The operations as the model gave them, or null when unreadable. */
  operations: unknown[] | null;
  model: string;
}

@Injectable()
export default class PageWriter {
  private run: WriterComplete = complete;
  private configured: () => boolean = isLLMConfigured;

  /** A writer over a given completion, for tests: no model is ever called. */
  static using(
    run: WriterComplete,
    options: { configured?: () => boolean } = {},
  ): PageWriter {
    return Object.assign(new PageWriter(), {
      run,
      configured: options.configured ?? (() => true),
    });
  }

  /** Whether a model can be asked at all. Without one, refreshes run in code. */
  available(): boolean {
    return this.configured();
  }

  /** The edits the model proposes. Throws when the model cannot be reached. */
  async operations(input: WriterInput): Promise<WriterAnswer> {
    const { text, model } = await this.run(
      'smart',
      pageRefresh.system,
      pageRefresh.prompt(input),
    );

    return { operations: pageRefresh.parse(text, input), model };
  }
}
