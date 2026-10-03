import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ToolSet,
} from 'ai';

import { generateText, stepCountIs, streamText } from 'ai';

import { LoggerService } from 'modules/logger/logger.service';

import { getLanguageModel, resolveModel } from './llm-provider';
import { startModelTelemetry } from './model-telemetry';

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
 * Each call also makes a span and records metrics. model-telemetry.ts has
 * the names.
 *
 * Do not call `generateText` or `streamText` from `ai` directly. A direct call
 * writes no log line and no span, and you cannot find it later.
 */

export interface ModelCall {
  /** The feature that makes the call, for example `triage.pair`. */
  purpose: string;
  /** A tier, or a legacy role or model id that `resolveModel` accepts. */
  tier?: string | null;
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
  const telemetry = startModelTelemetry(call.purpose);

  try {
    ({ tier: role, modelId: model } = resolveModel(call.tier));
    telemetry.setModel(role, model);

    const result = await telemetry.run(() =>
      generateText({
        model: getLanguageModel(model),
        ...input(call),
      }),
    );
    telemetry.finish(result.totalUsage, result.finishReason);

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
    telemetry.fail(error);
    logFailure(
      { purpose: call.purpose, role, model, durationMs: Date.now() - started },
      error,
    );
    throw error;
  }
}

/**
 * A call on a model that a workspace chose, with the key that the workspace
 * stored, rather than on the model of a role. The caller makes the client:
 * this file does not read the keys of a workspace.
 */
export interface WorkspaceModelCall {
  purpose: string;
  /** The provider and the model, as the agent settings name them. */
  provider: string;
  model: string;
  languageModel: LanguageModel;
  system?: string;
  prompt: string;
  temperature?: number;
  /** The tools the model can call, and the most steps it can take. */
  tools?: ToolSet;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}

/**
 * This function sends one prompt to a model that a workspace chose, lets the
 * model call its tools, and returns the last answer. It writes the same log
 * lines as `generateModelText`, with the role `workspace:<provider>`.
 */
export async function generateWorkspaceModelText(
  call: WorkspaceModelCall,
): Promise<ModelAnswer & { steps: number }> {
  const started = Date.now();
  const fields = () => ({
    purpose: call.purpose,
    role: `workspace:${call.provider}`,
    model: call.model,
    durationMs: Date.now() - started,
  });
  const telemetry = startModelTelemetry(
    call.purpose,
    `workspace:${call.provider}`,
    call.model,
    call.provider,
  );

  try {
    const result = await telemetry.run(() =>
      generateText({
        model: call.languageModel,
        ...input(call),
        ...(call.tools ? { tools: call.tools } : {}),
        stopWhen: stepCountIs(call.maxSteps ?? 1),
        ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
      }),
    );
    telemetry.finish(
      result.totalUsage,
      result.finishReason,
      result.steps.length,
    );

    logFinish(fields(), result.totalUsage, result.finishReason);
    logExchange(call, fields(), result.text);

    return {
      text: result.text,
      model: call.model,
      steps: result.steps.length,
    };
  } catch (error) {
    telemetry.fail(error);
    logFailure(fields(), error);
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
  const telemetry = startModelTelemetry(call.purpose);

  try {
    ({ tier: role, modelId: model } = resolveModel(call.tier));
    telemetry.setModel(role, model);
  } catch (error) {
    telemetry.fail(error);
    logFailure({ purpose: call.purpose, role, model, durationMs: 0 }, error);
    throw error;
  }

  const fields = () => ({
    purpose: call.purpose,
    role,
    model,
    durationMs: Date.now() - started,
  });

  return telemetry.run(() =>
    streamText({
      model: getLanguageModel(model),
      ...input(call),
      onFinish: async (event) => {
        telemetry.finish(event.totalUsage, event.finishReason);
        logFinish(fields(), event.totalUsage, event.finishReason);
        logExchange(call, fields(), event.text);
        await onFinish?.(event.text, model);
      },
      onError: ({ error }) => {
        telemetry.fail(error);
        logFailure(fields(), error);
      },
      // The client closed the stream. The span must end, or it stays open.
      onAbort: () => {
        telemetry.finish(undefined, 'abort');
      },
    }),
  );
}

/** The prompt part of a call, in the shape that `ai` accepts. */
function input(
  call: Pick<ModelCall, 'system' | 'temperature' | 'prompt' | 'messages'>,
) {
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

function logExchange(
  call: Pick<ModelCall, 'purpose' | 'system' | 'prompt' | 'messages'>,
  fields: CallFields,
  answer: string,
) {
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
