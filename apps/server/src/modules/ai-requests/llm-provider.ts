import type { LLMTier } from '@vantikhq/types';
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
 * Callers ask for a tier, never a model name. Which concrete model serves each
 * tier is the deployment's business, not the caller's: LLM_MODEL serves every
 * built-in text task, and LLM_MODEL_DECISIONS, when set, takes the decisions
 * the server acts on (triage, the citation judge, label and module
 * suggestions). Unset, the decisions go to LLM_MODEL too.
 */
const MODEL_ENV = 'LLM_MODEL';
const DECISIONS_ENV = 'LLM_MODEL_DECISIONS';

let client: OpenAICompatibleProvider | undefined;

function readEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is not set. AI features need an OpenAI-compatible endpoint: ` +
        `set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL. ` +
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
  return ['LLM_BASE_URL', 'LLM_API_KEY', MODEL_ENV].every((name) =>
    Boolean(process.env[name]?.trim()),
  );
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
 * Coerce whatever a caller sent into one of the two tiers.
 *
 * The AI endpoint is public API, so a server upgrade meets requests from
 * scripts written against an older one that still send a role (`fast`,
 * `smart`) or a wire model id, as the retired Actions did. Those callers asked
 * for text, not for a decision the server acts on, so all of them get the
 * default tier. This layer is permanent, not a migration shim: it is what
 * keeps those callers working.
 */
export function coerceTier(requested?: string | null): LLMTier {
  const value = requested?.trim();

  if (value === 'default' || value === 'decisions') {
    return value;
  }

  if (value) {
    logger.debug({
      message: `Coercing legacy model '${value}' to the default tier`,
      where: 'llm-provider.coerceTier',
    });
  }

  return 'default';
}

/**
 * Resolve a requested tier (or legacy role or model id) to the concrete model
 * this deployment serves it with. The decisions tier falls back to LLM_MODEL
 * when LLM_MODEL_DECISIONS is unset. Throws naming the missing variable rather
 * than falling back further: a misconfigured install must fail loudly, not
 * answer with whatever model happens to be reachable.
 */
export function resolveModel(requested?: string | null): {
  tier: LLMTier;
  modelId: string;
} {
  const tier = coerceTier(requested);
  const decisions = process.env[DECISIONS_ENV]?.trim();

  return {
    tier,
    modelId: tier === 'decisions' && decisions ? decisions : readEnv(MODEL_ENV),
  };
}

export function getLanguageModel(modelId: string): LanguageModel {
  return getLLMClient()(modelId) as LanguageModel;
}
