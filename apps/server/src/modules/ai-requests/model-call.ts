import type { LanguageModelUsage, ModelMessage } from 'ai';

import { generateText, streamText } from 'ai';

import { LoggerService } from 'modules/logger/logger.service';

import { getLanguageModel, resolveModel } from './llm-provider';

const logger = new LoggerService('LLM');

/**
 * All server calls to a model go through this file.
 *
 * Each call writes one log line when it ends. The line names the feature that
 * made the call, the role, the model, the duration, the token counts and the
 * finish reason. A call that fails writes an error line with the same fields
 * and the error. When LOG_LEVEL is `debug`, a second line holds the prompt and
 * the answer, so you can see what the model got and what it said.
 *
 * Do not call `generateText` or `streamText` from `ai` directly. A direct call
 * writes no log line, and you cannot find it later.
 */

export interface ModelCall {
  /** The feature that makes the call, for example `triage.pair`. */
  purpose: string;
  /** A role, or a legacy model id that `resolveModel` accepts. */
  role?: string | null;
  system?: string;
  temperature?: number;
  /** Give `prompt` or `messages`, not the two. */
  prompt?: string;
  messages?: ModelMessage[];
}

export interface ModelAnswer {
  text: string;
  /** The concrete model that answered. */
  model: string;
}

interface CallFields {
  purpose: string;
  role: string | null;
  model: string | null;
  durationMs: number;
}

/**
 * This function sends one prompt to a model and returns the full answer.
 */
export async function generateModelText(call: ModelCall): Promise<ModelAnswer> {
  const started = Date.now();
  let role: string | null = null;
  let model: string | null = null;

  try {
    ({ role, modelId: model } = resolveModel(call.role));

    const result = await generateText({
      model: getLanguageModel(model),
      ...input(call),
    });

    const fields = {
      purpose: call.purpose,
      role,
      model,
      durationMs: Date.now() - started,
    };
    logFinish(fields, result.totalUsage, result.finishReason);
    logExchange(call, fields, result.text);

    return { text: result.text, model };
  } catch (error) {
    logFailure(
      { purpose: call.purpose, role, model, durationMs: Date.now() - started },
      error,
    );
    throw error;
  }
}

/**
 * This function sends one prompt to a model and returns the stream of the
 * answer. The log line comes when the stream ends or fails.
 *
 * `onFinish` gets the full answer and the model that gave it.
 */
export function streamModelText(
  call: ModelCall,
  onFinish?: (text: string, model: string) => void | Promise<void>,
) {
  const started = Date.now();
  let role: string | null = null;
  let model: string | null = null;

  try {
    ({ role, modelId: model } = resolveModel(call.role));
  } catch (error) {
    logFailure({ purpose: call.purpose, role, model, durationMs: 0 }, error);
    throw error;
  }

  const fields = () => ({
    purpose: call.purpose,
    role,
    model,
    durationMs: Date.now() - started,
  });

  return streamText({
    model: getLanguageModel(model),
    ...input(call),
    onFinish: async (event) => {
      logFinish(fields(), event.totalUsage, event.finishReason);
      logExchange(call, fields(), event.text);
      await onFinish?.(event.text, model);
    },
    onError: ({ error }) => {
      logFailure(fields(), error);
    },
  });
}

/** The prompt part of a call, in the shape that `ai` accepts. */
function input(call: ModelCall) {
  const common = {
    ...(call.system !== undefined ? { system: call.system } : {}),
    ...(call.temperature !== undefined
      ? { temperature: call.temperature }
      : {}),
  };

  return call.messages
    ? { ...common, messages: call.messages }
    : { ...common, prompt: call.prompt ?? '' };
}

function logFinish(
  fields: CallFields,
  usage: LanguageModelUsage | undefined,
  finishReason: string | undefined,
) {
  logger.info({
    message: `${fields.purpose}: ${fields.model} answered in ${fields.durationMs} ms`,
    where: 'model-call',
    payload: {
      ...fields,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      finishReason,
    },
  });
}

function logFailure(fields: CallFields, error: unknown) {
  logger.error({
    message: `${fields.purpose}: ${fields.model ?? 'no model'} failed after ${fields.durationMs} ms`,
    where: 'model-call',
    payload: fields,
    error: error as Error,
  });
}

function logExchange(call: ModelCall, fields: CallFields, answer: string) {
  logger.debug({
    message: `${fields.purpose}: prompt and answer`,
    where: 'model-call',
    payload: {
      purpose: fields.purpose,
      model: fields.model,
      system: call.system,
      prompt: call.prompt,
      messages: call.messages,
      answer,
    },
  });
}
