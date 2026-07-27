/**
 * The model providers a workspace can bring a key for.
 *
 * One table, because four things have to agree about a provider and they are
 * maintained in different places: the id Pi wants after `--provider`, the
 * environment variable Pi reads the key from, the host the sandbox has to be
 * allowed to reach, and the endpoint that answers "what does this key get?".
 * Split across the server, the executor and the settings screen, these drift —
 * and the way they drift is silent. A key stored under a name the harness does
 * not read authenticates nothing, and the run fails with a model error that
 * says nothing about the real cause.
 *
 * Adding a provider is adding a row here. Deliberately not a database table:
 * this is knowledge about the world, versioned with the code that depends on
 * it, not configuration a workspace edits.
 */
export interface ModelProvider {
  /** The value passed to Pi's `--provider`. */
  id: string;
  label: string;
  /**
   * The environment variable Pi reads this provider's key from. The whole
   * reason this table exists: Pi has no generic key variable, so a workspace
   * key has to arrive under the exact name its provider expects.
   */
  envVar: string;
  /** Host the sandbox must reach, for the egress allowlist. */
  host: string;
  /** Shown in the empty key field, so a paste can be sanity-checked by eye. */
  placeholder: string;
  /**
   * Where the account's own endpoint goes, for providers that have one per
   * customer. Absent means the provider has a single fixed endpoint and asking
   * for one would be a field nobody can fill in correctly.
   */
  baseUrl?: {
    envVar: string;
    required: boolean;
    placeholder: string;
  };
  /**
   * How to ask this provider what the key can reach.
   *
   * Absent means there is no list to fetch and a model has to be typed. The
   * key is still stored — a provider without a catalogue endpoint is not a
   * provider a workspace should be unable to use.
   */
  catalogue?: {
    url: string;
    /**
     * `bearer` — `Authorization: Bearer <key>`, the OpenAI convention most
     * providers copy. `header` — a named header, which is Anthropic. `query` —
     * appended to the URL, which is Google, and the reason a catalogue URL is
     * never logged.
     */
    auth: 'bearer' | 'header' | 'query';
    /** For `header`, the name; for `query`, the parameter. */
    authName?: string;
    /** Sent as-is. Anthropic refuses a request without its version header. */
    headers?: Record<string, string>;
    /**
     * An endpoint that actually requires the key, when the model list does
     * not.
     *
     * OpenRouter publishes its catalogue to anyone, so listing it proves only
     * that OpenRouter is up — a wrong key returns the same 367 models as a
     * right one. Without this, "check the key" silently checks nothing.
     */
    verifyUrl?: string;
    /**
     * Statuses that mean the key is wrong, beyond 401 and 403.
     *
     * Google answers a bad key with 400 rather than 401, so treating 400 as
     * "something went wrong, store it anyway" accepts keys that will never
     * work.
     */
    rejectStatuses?: number[];
  };
}

export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    host: 'api.anthropic.com',
    placeholder: 'sk-ant-…',
    catalogue: {
      url: 'https://api.anthropic.com/v1/models?limit=100',
      auth: 'header',
      authName: 'x-api-key',
      // Anthropic rejects a request that does not name a version, so this is
      // not optional politeness.
      headers: { 'anthropic-version': '2023-06-01' },
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    host: 'api.openai.com',
    placeholder: 'sk-…',
    catalogue: { url: 'https://api.openai.com/v1/models', auth: 'bearer' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    host: 'openrouter.ai',
    placeholder: 'sk-or-…',
    catalogue: {
      url: 'https://openrouter.ai/api/v1/models',
      auth: 'bearer',
      // The model list is public and ignores the key entirely. This endpoint
      // returns the key's own limits and refuses an unknown one, so it is what
      // "check the key" has to ask.
      verifyUrl: 'https://openrouter.ai/api/v1/key',
    },
  },
  {
    id: 'google',
    label: 'Google Gemini',
    // Not `GOOGLE_API_KEY`. Pi reads this one, and the two names are close
    // enough that guessing costs an afternoon.
    envVar: 'GEMINI_API_KEY',
    host: 'generativelanguage.googleapis.com',
    placeholder: 'AIza…',
    catalogue: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      auth: 'query',
      authName: 'key',
      // Google answers an invalid key with 400 and API_KEY_INVALID, not 401.
      // Without this a wrong key reads as "the provider had a problem" and is
      // stored.
      rejectStatuses: [400],
    },
  },
  {
    id: 'xai',
    label: 'xAI',
    envVar: 'XAI_API_KEY',
    host: 'api.x.ai',
    placeholder: 'xai-…',
    catalogue: { url: 'https://api.x.ai/v1/models', auth: 'bearer' },
  },
  {
    id: 'groq',
    label: 'Groq',
    envVar: 'GROQ_API_KEY',
    host: 'api.groq.com',
    placeholder: 'gsk_…',
    catalogue: { url: 'https://api.groq.com/openai/v1/models', auth: 'bearer' },
  },
  {
    id: 'mistral',
    label: 'Mistral',
    envVar: 'MISTRAL_API_KEY',
    host: 'api.mistral.ai',
    placeholder: '…',
    catalogue: { url: 'https://api.mistral.ai/v1/models', auth: 'bearer' },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    envVar: 'DEEPSEEK_API_KEY',
    host: 'api.deepseek.com',
    placeholder: 'sk-…',
    catalogue: { url: 'https://api.deepseek.com/models', auth: 'bearer' },
  },
  {
    id: 'together',
    label: 'Together AI',
    envVar: 'TOGETHER_API_KEY',
    host: 'api.together.xyz',
    placeholder: '…',
    catalogue: { url: 'https://api.together.xyz/v1/models', auth: 'bearer' },
  },
  {
    id: 'azure-openai-responses',
    label: 'Azure OpenAI',
    envVar: 'AZURE_OPENAI_API_KEY',
    // The real host is the resource's own. Kept as a placeholder the egress
    // list never uses: for Azure the allowlist comes from the base URL below,
    // which is required precisely because there is no shared host.
    host: '',
    placeholder: '…',
    baseUrl: {
      envVar: 'AZURE_OPENAI_BASE_URL',
      required: true,
      placeholder: 'https://your-resource.openai.azure.com',
    },
    // No catalogue: on Azure the models are deployments the customer named, so
    // there is no list that means the same thing as it does elsewhere.
  },
];

export function providerById(id: string | undefined): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * How hard the model is asked to think, in Pi's own vocabulary.
 *
 * Passed straight through to `--thinking`. Named here rather than typed as a
 * string so the settings screen and the harness cannot disagree about what the
 * levels are.
 */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** What a workspace or a single run asks the harness to run on. */
export interface ModelChoice {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}
