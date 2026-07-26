import type { LLMRole } from '@vantikhq/types';
import type { LanguageModel } from 'ai';

import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from '@ai-sdk/openai-compatible';

import { LoggerService } from 'modules/logger/logger.service';

const logger = new LoggerService('LLMProvider');

/**
 * Every endpoint we care about — OpenRouter, LM Studio, Ollama, vLLM, direct
 * OpenAI — speaks the OpenAI API, so the provider is configuration rather than
 * code: one client pointed at LLM_BASE_URL with LLM_API_KEY.
 *
 * Callers ask for a role, never a model name. Which concrete model serves each
 * role is the deployment's business, not the caller's.
 */
const MODEL_ENV: Record<LLMRole, string> = {
  fast: 'LLM_MODEL_FAST',
  smart: 'LLM_MODEL_SMART',
};

let client: OpenAICompatibleProvider | undefined;

function readEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is not set. AI features need an OpenAI-compatible endpoint: ` +
        `set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_FAST and LLM_MODEL_SMART. ` +
        `See docs/oss/self-deployment for the supported setups.`,
    );
  }

  return value;
}

/**
 * Whether this install has an endpoint to talk to at all.
 *
 * Read by the client config endpoint so the browser can leave the AI
 * affordances out of the interface entirely, rather than offering buttons that
 * fail when pressed. A request that arrives anyway still throws — hiding a
 * feature is not the same as pretending it worked.
 */
export function isLLMConfigured(): boolean {
  return [
    'LLM_BASE_URL',
    'LLM_API_KEY',
    'LLM_MODEL_FAST',
    'LLM_MODEL_SMART',
  ].every((name) => Boolean(process.env[name]?.trim()));
}

/**
 * The client is memoized rather than rebuilt per request: it holds no per-call
 * state, and rebuilding it would throw away the agent's connection pool.
 */
export function getLLMClient(): OpenAICompatibleProvider {
  if (client) {
    return client;
  }

  const headers: Record<string, string> = {};
  const appUrl = process.env.LLM_APP_URL?.trim();
  const appName = process.env.LLM_APP_NAME?.trim();

  // OpenRouter attributes usage to an app through these two headers and shows
  // it on the public leaderboards. Every other endpoint ignores them.
  if (appUrl) {
    headers['HTTP-Referer'] = appUrl;
  }
  if (appName) {
    headers['X-Title'] = appName;
  }

  client = createOpenAICompatible({
    name: 'vantik',
    baseURL: readEnv('LLM_BASE_URL'),
    // Local servers do not check it, but they do not mind one either, so the
    // key stays required and self-hosters set a placeholder. An install that
    // forgot to configure a provider should say so, not answer badly.
    apiKey: readEnv('LLM_API_KEY'),
    ...(Object.keys(headers).length ? { headers } : {}),
  });

  return client;
}

/**
 * Coerce whatever a caller sent into one of the two roles.
 *
 * Actions in `actions/` deploy to trigger.dev independently of the server, so a
 * server upgrade meets requests from action code that is months old and still
 * sends wire model IDs. This layer is permanent, not a migration shim: it is
 * what keeps those installs working.
 */
export function coerceRole(requested?: string | null): LLMRole {
  const value = requested?.trim();

  if (!value) {
    return 'fast';
  }

  if (value === 'fast' || value === 'smart') {
    return value;
  }

  const lowered = value.toLowerCase();

  // Only ids we recognise as one of the big models take the paid role. Anything
  // else — a small local model like llama3 or gemma2:2b, a wrong-cased 'Fast',
  // an id we have never seen — takes the cheap one, which is the same default
  // an empty value gets and the same role the migration gave LLAMA3. When we
  // are guessing, guess cheap.
  const small =
    /^gpt-3\.5/.test(lowered) ||
    lowered.includes('mini') ||
    lowered.includes('haiku');
  const large =
    lowered.includes('gpt-4') ||
    lowered.includes('opus') ||
    lowered.includes('sonnet');

  const role: LLMRole = large && !small ? 'smart' : 'fast';

  logger.debug({
    message: `Coercing legacy model id '${value}' to role '${role}'`,
    where: 'llm-provider.coerceRole',
  });

  return role;
}

/**
 * Resolve a requested role (or legacy model id) to the concrete model this
 * deployment serves it with. Throws naming the missing variable rather than
 * falling back — a misconfigured install must fail loudly, not answer with
 * whatever model happens to be reachable.
 */
export function resolveModel(requested?: string | null): {
  role: LLMRole;
  modelId: string;
} {
  const role = coerceRole(requested);

  return { role, modelId: readEnv(MODEL_ENV[role]) };
}

export function getLanguageModel(modelId: string): LanguageModel {
  return getLLMClient()(modelId) as LanguageModel;
}
