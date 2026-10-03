import type {
  MeteredApi,
  MeteredModelCall,
  MeteredUsage,
} from "@vantikhq/types";

/**
 * Reads the usage of one model call out of the provider's response, as the
 * bytes pass through.
 *
 * A streamed answer is a sequence of server-sent events, and the usage comes in
 * the last few of them; a plain answer is one JSON body. Either way the reader
 * keeps only what it needs (the id, the model, the latest usage block) and
 * never the content, so a long answer costs it no memory.
 *
 * Each API puts usage somewhere else and counts it differently:
 *
 * - OpenAI chat completions, which OpenRouter and most gateways speak: `usage`
 *   on the last chunk. `prompt_tokens` already includes cached tokens.
 *   OpenRouter adds `cost`, what it billed, and the upstream `provider`.
 * - Anthropic messages: `message_start` carries the id and the input counts,
 *   and `message_delta` the running output count. `input_tokens` excludes the
 *   cache reads and writes, which are counted apart.
 * - OpenAI responses: the whole usage on `response.completed`.
 * - Gemini: `usageMetadata` on each chunk, cumulative. `promptTokenCount`
 *   includes cached tokens; `toolUsePromptTokenCount` is billed as input but
 *   counted apart.
 *
 * Anything else, including Bedrock's binary event stream, is recorded with its
 * status and timing and no usage.
 */
export class UsageReader {
  private api: MeteredApi = "unknown";
  private responseId?: string;
  private model?: string;
  private upstreamProvider?: string;
  private usage?: MeteredUsage;
  private costUsd?: number;
  private byok?: boolean;
  private raw?: Record<string, unknown>;

  private readonly decoder = new TextDecoder();
  private pending = "";
  /** A non-streamed body is parsed once, whole. */
  private body = "";
  private bodyTooLarge = false;

  constructor(private readonly streamed: boolean) {}

  push(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true });

    if (!this.streamed) {
      if (this.body.length + text.length > MAX_JSON_BODY_CHARS) {
        this.bodyTooLarge = true;
        this.body = "";
      } else if (!this.bodyTooLarge) {
        this.body += text;
      }
      return;
    }

    const lines = (this.pending + text).split("\n");
    this.pending = lines.pop() ?? "";

    for (const line of lines) {
      this.line(line);
    }

    // A line this long is content, never a usage chunk; holding it would let
    // one huge chunk grow the buffer without end.
    if (this.pending.length > MAX_LINE_CHARS) {
      this.pending = "";
    }
  }

  /** What the response said, once it has ended. */
  finish(): Omit<
    MeteredModelCall,
    "seq" | "host" | "status" | "startedAt" | "durationMs"
  > {
    const tail = this.decoder.decode();

    if (this.streamed) {
      this.line(this.pending + tail);
    } else if (!this.bodyTooLarge) {
      this.event(parseJson(this.body + tail));
    }

    return {
      api: this.api,
      ...(this.responseId ? { responseId: this.responseId } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.upstreamProvider
        ? { upstreamProvider: this.upstreamProvider }
        : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
      ...(this.byok !== undefined ? { byok: this.byok } : {}),
      ...(this.raw ? { raw: this.raw } : {}),
    };
  }

  private line(line: string): void {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) {
      return;
    }

    const data = trimmed.slice(5).trim();

    if (!data || data === "[DONE]") {
      return;
    }

    this.event(parseJson(data));
  }

  private event(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }

    // Anthropic: the type names the event.
    if (value.type === "message_start" && isRecord(value.message)) {
      this.api = "anthropic-messages";
      this.anthropic(value.message, true);
      return;
    }
    if (value.type === "message_delta" && isRecord(value.usage)) {
      this.api = "anthropic-messages";
      this.anthropicUsage(value.usage);
      return;
    }
    if (value.type === "message" && value.role === "assistant") {
      this.api = "anthropic-messages";
      this.anthropic(value, true);
      return;
    }

    // OpenAI responses.
    if (
      (value.type === "response.completed" ||
        value.type === "response.incomplete") &&
      isRecord(value.response)
    ) {
      this.api = "openai-responses";
      this.responses(value.response);
      return;
    }
    if (value.object === "response") {
      this.api = "openai-responses";
      this.responses(value);
      return;
    }

    // Gemini.
    if (isRecord(value.usageMetadata) || typeof value.responseId === "string") {
      this.api = "google";
      this.gemini(value);
      return;
    }

    // OpenAI chat completions, and everything that speaks it.
    if (
      value.object === "chat.completion.chunk" ||
      value.object === "chat.completion" ||
      Array.isArray(value.choices)
    ) {
      this.api = "openai-chat";
      this.chat(value);
    }
  }

  private chat(value: Record<string, unknown>): void {
    this.responseId ??= string(value.id);
    this.model = string(value.model) ?? this.model;
    this.upstreamProvider = string(value.provider) ?? this.upstreamProvider;

    if (!isRecord(value.usage)) {
      return;
    }

    const usage = value.usage;
    const prompt = details(usage, "prompt_tokens_details");
    const completion = details(usage, "completion_tokens_details");

    this.usage = compact({
      input: number(usage.prompt_tokens) ?? 0,
      output: number(usage.completion_tokens) ?? 0,
      cacheRead: number(prompt.cached_tokens),
      cacheWrite: number(prompt.cache_write_tokens),
      reasoning: number(completion.reasoning_tokens),
    });
    this.costUsd = number(usage.cost) ?? this.costUsd;
    this.byok = typeof usage.is_byok === "boolean" ? usage.is_byok : this.byok;
    this.raw = capped(usage);
  }

  private anthropic(message: Record<string, unknown>, start: boolean): void {
    this.responseId ??= string(message.id);
    this.model = string(message.model) ?? this.model;

    if (isRecord(message.usage)) {
      this.anthropicUsage(message.usage, start);
    }
  }

  /**
   * `message_start` gives the input counts and a first output count;
   * `message_delta` gives the running totals, which may repeat the input
   * counts. So each field keeps its latest value.
   */
  private anthropicUsage(usage: Record<string, unknown>, reset = false): void {
    const previous = reset ? undefined : this.rawAnthropic;
    const merged: Record<string, unknown> = { ...previous, ...usage };
    this.rawAnthropic = merged;

    const fresh = number(merged.input_tokens) ?? 0;
    const cacheRead = number(merged.cache_read_input_tokens);
    const cacheWrite = number(merged.cache_creation_input_tokens);
    const tools = isRecord(merged.server_tool_use)
      ? merged.server_tool_use
      : {};

    this.usage = compact({
      input: fresh + (cacheRead ?? 0) + (cacheWrite ?? 0),
      output: number(merged.output_tokens) ?? 0,
      cacheRead,
      cacheWrite,
      webSearches: number(tools.web_search_requests),
    });
    this.raw = capped(merged);
  }

  private rawAnthropic?: Record<string, unknown>;

  private responses(response: Record<string, unknown>): void {
    this.responseId ??= string(response.id);
    this.model = string(response.model) ?? this.model;

    if (!isRecord(response.usage)) {
      return;
    }

    const usage = response.usage;
    const input = details(usage, "input_tokens_details");
    const output = details(usage, "output_tokens_details");

    this.usage = compact({
      input: number(usage.input_tokens) ?? 0,
      output: number(usage.output_tokens) ?? 0,
      cacheRead: number(input.cached_tokens),
      reasoning: number(output.reasoning_tokens),
    });
    this.raw = capped(usage);
  }

  private gemini(value: Record<string, unknown>): void {
    this.responseId ??= string(value.responseId);
    this.model = string(value.modelVersion) ?? this.model;

    if (!isRecord(value.usageMetadata)) {
      return;
    }

    const usage = value.usageMetadata;
    const toolUse = number(usage.toolUsePromptTokenCount);
    const thoughts = number(usage.thoughtsTokenCount);

    this.usage = compact({
      input: (number(usage.promptTokenCount) ?? 0) + (toolUse ?? 0),
      output: (number(usage.candidatesTokenCount) ?? 0) + (thoughts ?? 0),
      cacheRead: number(usage.cachedContentTokenCount),
      reasoning: thoughts,
      toolUsePrompt: toolUse,
    });
    this.raw = capped(usage);
  }
}

/** A plain JSON answer longer than this is not parsed for usage. */
const MAX_JSON_BODY_CHARS = 8 * 1024 * 1024;
/** A server-sent event line longer than this is dropped unread. */
const MAX_LINE_CHARS = 1024 * 1024;
/** The provider's usage block is kept up to this size, as JSON. */
const MAX_RAW_CHARS = 4096;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 200) : undefined;
}

function details(
  usage: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = usage[key];
  return isRecord(value) ? value : {};
}

function compact(usage: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  webSearches?: number;
  toolUsePrompt?: number;
}): MeteredUsage {
  return Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined),
  ) as unknown as MeteredUsage;
}

function capped(
  usage: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const json = JSON.stringify(usage);
  return json.length <= MAX_RAW_CHARS ? usage : undefined;
}
