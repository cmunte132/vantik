/**
 * What the sandbox host saw of one model call, read from the provider's own
 * response as it passed through the egress.
 *
 * The harness inside the guest reports usage too, but it reports what it
 * parsed, and it prices calls from its own catalog: it keeps no cost that a
 * provider sends, and it drops usage that it has no field for (the web
 * searches of an Anthropic call, the tool-use prompt tokens of a Gemini call).
 * It also runs where the agent has a shell. This record is read on the host,
 * from the bytes the provider sent, so it is the figure to bill by.
 *
 * It holds counts and the provider's usage block, and never a prompt, an
 * answer or a header.
 */
export interface MeteredModelCall {
  /** The order of the call in its sandbox, from 0. */
  seq: number;
  /** The provider host the call went to. */
  host: string;
  /** The API the response was read as, or `unknown` when none matched. */
  api: MeteredApi;
  /** The provider's HTTP status. */
  status: number;
  /** When the request left, in ms since the epoch. */
  startedAt: number;
  /** From the request leaving to the last byte of the response. */
  durationMs: number;
  /**
   * The provider's id for the response: `gen-…` at OpenRouter, `msg_…` at
   * Anthropic. The harness keeps the same id on its message, which is how the
   * two records of one call are joined.
   */
  responseId?: string;
  /** The model the provider says answered. */
  model?: string;
  /** The provider a gateway routed the call to, when it says (OpenRouter). */
  upstreamProvider?: string;
  usage?: MeteredUsage;
  /**
   * What the provider billed for the call, in USD. Only a gateway sends this
   * (OpenRouter's `usage.cost`); a direct provider sends counts and bills by
   * its price list, so this is absent rather than zero.
   */
  costUsd?: number;
  /** True when a gateway billed the call to the caller's own provider key. */
  byok?: boolean;
  /** The provider's usage block as it sent it, size-capped. */
  raw?: Record<string, unknown>;
}

export type MeteredApi =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google'
  | 'unknown';

/** Token counts with one meaning across providers. */
export interface MeteredUsage {
  /**
   * Every input token, cached or not, as the OpenTelemetry conventions count
   * them. Includes Gemini's tool-use prompt tokens, which are billed as input.
   */
  input: number;
  /** Output tokens, reasoning included. */
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** Server-side web searches, billed per search (Anthropic). */
  webSearches?: number;
  /** Gemini's tool-use prompt tokens, also counted in `input`. */
  toolUsePrompt?: number;
}

/** `GET /v1/sandboxes/:id/model-calls?since=<seq>` */
export interface SandboxHostModelCalls {
  calls: MeteredModelCall[];
  /** The `since` to ask with next. */
  next: number;
}
